import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { isModuleLocked, unlockAtFrom } from "@/modules/courses/module-unlock";
import { CacheService } from "@/services/cache.service";
import { JwtService } from "@/services/jwt.service";

/**
 * @info - Drip modules: a date closes a module, and a closed module shows stubs.
 *
 * The rule is deliberately not a new mechanism: it lives in `isLessonVisibleTo`, the same
 * guard that keeps an unpublished lesson out of a student's hands, so every path that names
 * a lesson by id (completion, quiz take, quiz submit, autosave, assessment start, assessment
 * session) is covered by the change that adds it. What is new is the payload: a student is
 * told the module is closed and when it opens rather than being shown nothing, so the
 * sidebar can render it and progress can count it. A stub is built from a whitelist, and
 * this suite asserts the key set rather than trusting that.
 *
 * Requires local Postgres + Redis, like every DB-backed test here.
 */

const OWNER_AUTH = "auth:module-drip-owner";
const OTHER_AUTH = "auth:module-drip-other";
const STUDENT_AUTH = "auth:module-drip-student";
const ADMIN_AUTH = "auth:module-drip-admin";

const OWNER_EMAIL = "module.drip.owner@hive.test";
const OTHER_EMAIL = "module.drip.other@hive.test";
const STUDENT_EMAIL = "module.drip.student@hive.test";
const ADMIN_EMAIL = "module.drip.admin@hive.test";
const SLUG = "module-drip-course";
const COMMUNITY_SLUG = "module-drip-community";

const STUB_KEYS = [
	"duration",
	"id",
	"lockReason",
	"sortOrder",
	"status",
	"title",
	"type",
];

let db: ReturnType<typeof getDb>;
let app: Hono;
const tokens: Record<string, string> = {};
/* @info - Read through one place so an unknown auth id is a loud failure in the test
 * rather than an undefined handed to a request header. */
let courseId: number;
let lockedModuleId: number;
let openModuleId: number;
let pastModuleId: number;
let lockedTextLessonId: number;
let lockedQuizLessonId: number;
let lockedAssessmentLessonId: number;
let openLessonId: number;
let quizQuestionId: number;
let enrollmentId: number;

const sql = async (statement: string) => {
	const result = await db.execute(statement);
	return result.rows as any[];
};
const one = async (statement: string) => (await sql(statement))[0];

const cleanup = async () => {
	const courses = `(SELECT id FROM courses WHERE slug = '${SLUG}')`;
	const modules = `(SELECT id FROM modules WHERE course_id IN ${courses})`;
	const lessons = `(SELECT id FROM lessons WHERE module_id IN ${modules})`;

	await sql(`DELETE FROM assessment_sessions WHERE lesson_id IN ${lessons}`);
	await sql(`DELETE FROM quiz_attempts WHERE lesson_id IN ${lessons}`);
	await sql(`DELETE FROM quiz_questions WHERE lesson_id IN ${lessons}`);
	await sql(`DELETE FROM lesson_progress WHERE lesson_id IN ${lessons}`);
	await sql(`DELETE FROM enrollments WHERE course_id IN ${courses}`);
	await sql(`DELETE FROM lessons WHERE module_id IN ${modules}`);
	await sql(`DELETE FROM modules WHERE course_id IN ${courses}`);
	await sql(`DELETE FROM courses WHERE slug = '${SLUG}'`);
	await sql(`DELETE FROM communities WHERE slug = '${COMMUNITY_SLUG}'`);
	await sql(
		`DELETE FROM users WHERE lower(email) IN ('${OWNER_EMAIL}', '${OTHER_EMAIL}', '${STUDENT_EMAIL}', '${ADMIN_EMAIL}')`,
	);
};

const get = (path: string, token: string) =>
	app.request(`/api/v1${path}`, {
		headers: { Authorization: `Bearer ${token}` },
	});

const post = (path: string, token: string, body?: unknown) =>
	app.request(`/api/v1${path}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body ?? {}),
	});

const patch = (path: string, token: string, body: unknown) =>
	app.request(`/api/v1${path}`, {
		method: "PATCH",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

const lessonsOf = async (res: Response) => {
	const body = (await res.json()) as any;
	return (body?.data?.data ?? []) as any[];
};

const unlockAtOf = async (moduleId: number) =>
	(await one(`SELECT unlock_at FROM modules WHERE id = ${moduleId}`))
		?.unlock_at;

beforeAll(async () => {
	await connectPostgresDB(() => {});
	db = getDb();

	await cleanup();

	const { testApp } = await import("./setup");
	app = testApp;
	const jwt = JwtService.getInstance();
	const cache = CacheService.getInstance();

	const mkUser = async (first: string, email: string, roles: string[]) => {
		const id = (
			await one(
				`INSERT INTO users (first_name, last_name, email, onboarded) VALUES ('${first}', 'Tester', '${email}', true) RETURNING id`,
			)
		).id as number;
		for (const role of roles) {
			await sql(
				`INSERT INTO user_roles (user_id, role) VALUES (${id}, '${role}')`,
			);
		}
		return id;
	};
	const signIn = async (
		authId: string,
		id: number,
		email: string,
		roles: string[],
	) => {
		tokens[authId] = jwt.generateToken(authId);
		await cache.set(authId, {
			id,
			email,
			firstName: "Drip",
			roles,
			isAuthenticated: true,
		});
	};

	const ownerId = await mkUser("Own", OWNER_EMAIL, ["instructor"]);
	const otherId = await mkUser("Oth", OTHER_EMAIL, ["instructor"]);
	const studentId = await mkUser("Stu", STUDENT_EMAIL, ["student"]);
	const adminId = await mkUser("Adm", ADMIN_EMAIL, ["admin"]);

	await signIn(OWNER_AUTH, ownerId, OWNER_EMAIL, ["instructor"]);
	await signIn(OTHER_AUTH, otherId, OTHER_EMAIL, ["instructor"]);
	await signIn(STUDENT_AUTH, studentId, STUDENT_EMAIL, ["student"]);
	await signIn(ADMIN_AUTH, adminId, ADMIN_EMAIL, ["admin"]);

	const existingCommunity = await one(
		`SELECT id FROM communities ORDER BY id LIMIT 1`,
	);
	const communityId = existingCommunity
		? existingCommunity.id
		: (
				await one(
					`INSERT INTO communities (name, slug, owner_id) VALUES ('Drip Community', '${COMMUNITY_SLUG}', ${ownerId}) RETURNING id`,
				)
			).id;

	courseId = (
		await one(
			`INSERT INTO courses (instructor_id, community_id, title, slug, status) VALUES (${ownerId}, ${communityId}, 'Drip Course', '${SLUG}', 'published') RETURNING id`,
		)
	).id as number;

	enrollmentId = (
		await one(
			`INSERT INTO enrollments (user_id, course_id, progress_percent) VALUES (${studentId}, ${courseId}, 0) RETURNING id`,
		)
	).id as number;

	/* Two years out, so this test never becomes a flaky clock test. */
	lockedModuleId = (
		await one(
			`INSERT INTO modules (course_id, title, sort_order, unlock_at) VALUES (${courseId}, 'Locked module', 0, now() + interval '2 years') RETURNING id`,
		)
	).id as number;
	openModuleId = (
		await one(
			`INSERT INTO modules (course_id, title, sort_order) VALUES (${courseId}, 'Open module', 1) RETURNING id`,
		)
	).id as number;
	pastModuleId = (
		await one(
			`INSERT INTO modules (course_id, title, sort_order, unlock_at) VALUES (${courseId}, 'Past module', 2, now() - interval '1 day') RETURNING id`,
		)
	).id as number;

	/* @info - The past-dated module needs a lesson, or the control below cannot fail:
	 * an assertion that a module returns [] is satisfied by any response, including an
	 * error envelope, so it proves nothing about a date that has passed. */
	await one(
		`INSERT INTO lessons (module_id, title, type, status, sort_order, description)
		 VALUES (${pastModuleId}, 'Past lesson', 'text', 'published', 0, 'readable body')
		 RETURNING id`,
	);

	lockedTextLessonId = (
		await one(
			`INSERT INTO lessons (module_id, title, description, type, status, sort_order) VALUES (${lockedModuleId}, 'Locked text lesson', 'secret body', 'text', 'published', 0) RETURNING id`,
		)
	).id as number;
	lockedQuizLessonId = (
		await one(
			`INSERT INTO lessons (module_id, title, type, status, sort_order) VALUES (${lockedModuleId}, 'Locked quiz', 'quiz', 'published', 1) RETURNING id`,
		)
	).id as number;
	lockedAssessmentLessonId = (
		await one(
			`INSERT INTO lessons (module_id, title, type, status, sort_order, time_limit_minutes) VALUES (${lockedModuleId}, 'Locked assessment', 'assessment', 'published', 2, 30) RETURNING id`,
		)
	).id as number;
	openLessonId = (
		await one(
			`INSERT INTO lessons (module_id, title, description, type, status, sort_order) VALUES (${openModuleId}, 'Open lesson', 'readable body', 'text', 'published', 0) RETURNING id`,
		)
	).id as number;

	quizQuestionId = (
		await one(
			`INSERT INTO quiz_questions (lesson_id, type, text, options, correct_answer, points, sort_order) VALUES (${lockedQuizLessonId}, 'multiple', 'Q?', '["a","b"]', 'a', 1, 0) RETURNING id`,
		)
	).id as number;
});

afterAll(async () => {
	await cleanup();
});

describe("the date itself", () => {
	it("reads a bare date as first thing that morning in Lagos, not in UTC", () => {
		const instant = unlockAtFrom("2026-10-19") as Date;
		expect(instant.toISOString()).toBe("2026-10-18T23:00:00.000Z");
	});

	it("takes a full instant as given, clears on null, and leaves an absent key alone", () => {
		expect(
			(unlockAtFrom("2026-10-19T12:34:56.000Z") as Date).toISOString(),
		).toBe("2026-10-19T12:34:56.000Z");
		expect(unlockAtFrom(null)).toBeNull();
		expect(unlockAtFrom(undefined)).toBeUndefined();
	});

	it("refuses nonsense instead of storing an unreadable date", () => {
		expect(() => unlockAtFrom("next tuesday")).toThrow(/valid date/);
	});

	it("treats a module with no date, or one exactly now, as open", () => {
		expect(isModuleLocked(null)).toBe(false);
		expect(isModuleLocked(undefined)).toBe(false);
		const now = new Date("2026-10-19T00:00:00.000Z");
		expect(isModuleLocked(now, now)).toBe(false);
		expect(isModuleLocked(new Date("2026-10-19T00:00:01.000Z"), now)).toBe(
			true,
		);
	});
});

describe("what a student receives", () => {
	it("gets stubs for a module that has not opened, and no content of any kind", async () => {
		const rows = await lessonsOf(
			await get(`/modules/${lockedModuleId}/lessons`, tokens[STUDENT_AUTH] as string),
		);
		expect(rows).toHaveLength(3);
		for (const row of rows) {
			expect(Object.keys(row).sort()).toEqual(STUB_KEYS);
			expect(row.status).toBe("locked");
			expect(row.lockReason).toBe("module_not_open");
			expect(row.title).toBeTruthy();
			/* The keys a stub must never carry, named so a future filter cannot "help". */
			for (const leaked of [
				"description",
				"videoUrl",
				"pdfUrl",
				"pptxUrl",
				"driveUrl",
				"attachmentUrl",
				"meetingUrl",
				"settings",
				"options",
				"correctAnswer",
				"explanation",
				"freePreview",
			]) {
				expect(row).not.toHaveProperty(leaked);
			}
		}
	});

	it("gets the real lessons of a module that is open, and of one whose date has passed", async () => {
		const open = await lessonsOf(
			await get(`/modules/${openModuleId}/lessons`, tokens[STUDENT_AUTH] as string),
		);
		expect(open[0].id).toBe(openLessonId);
		expect(open[0].status).toBe("published");
		expect(open[0].description).toBe("readable body");

		const pastRes = await get(
			`/modules/${pastModuleId}/lessons`,
			tokens[STUDENT_AUTH] as string,
		);
		expect(pastRes.status).toBe(200);
		const past = await lessonsOf(pastRes);
		expect(past[0].status).toBe("published");
		expect(past[0].description).toBe("readable body");
	});

	it("is told which modules are locked, and when they open", async () => {
		const body = (await (
			await get(`/courses/${courseId}/modules`, tokens[STUDENT_AUTH] as string)
		).json()) as any;
		const modules = (body?.data?.data ?? []) as any[];
		const locked = modules.find((m) => m.id === lockedModuleId);
		const open = modules.find((m) => m.id === openModuleId);

		expect(locked.locked).toBe(true);
		expect(locked.unlockAt).toBeTruthy();
		expect(open.locked).toBe(false);
	});
});

describe("the owner and an admin", () => {
	it("sees the whole module, lessons included, and no lock", async () => {
		for (const token of [tokens[OWNER_AUTH] as string, tokens[ADMIN_AUTH] as string]) {
			const rows = await lessonsOf(
				await get(`/modules/${lockedModuleId}/lessons`, token),
			);
			expect(rows).toHaveLength(3);
			expect(rows[0].status).toBe("published");
			expect(rows[0].description).toBe("secret body");

			const body = (await (
				await get(`/courses/${courseId}/modules`, token)
			).json()) as any;
			const locked = ((body?.data?.data ?? []) as any[]).find(
				(m) => m.id === lockedModuleId,
			);
			expect(locked.locked).toBe(false);
		}
	});
});

describe("every path that names a lesson by id", () => {
	it("refuses with the reason, not with the wrong reason", async () => {
		const progress = await patch(
			`/enrollments/${enrollmentId}/progress/${lockedTextLessonId}`,
			tokens[STUDENT_AUTH] as string,
			{},
		);
		expect(progress.status).toBe(403);
		/* The envelope's error is an object, so the refusal is asserted as text wherever it
		 * sits inside it rather than guessing a key. */
		expect(JSON.stringify(await progress.json())).toMatch(
			/module is not open/i,
		);

		const take = await get(
			`/quiz/lessons/${lockedQuizLessonId}/take`,
			tokens[STUDENT_AUTH] as string,
		);
		expect(take.status).toBe(403);
		expect(JSON.stringify(await take.json())).toMatch(/module is not open/i);

		const submit = await post(`/quiz/attempts`, tokens[STUDENT_AUTH] as string, {
			lessonId: lockedQuizLessonId,
			answers: [{ questionId: quizQuestionId, selectedAnswer: "a" }],
		});
		expect(submit.status).toBe(403);
		expect(JSON.stringify(await submit.json())).toMatch(/module is not open/i);

		const autosave = await post(
			`/quiz/attempts/autosave`,
			tokens[STUDENT_AUTH] as string,
			{
				lessonId: lockedQuizLessonId,
				questionId: quizQuestionId,
				selectedAnswer: "a",
			},
		);
		expect(autosave.status).toBe(403);
		expect(JSON.stringify(await autosave.json())).toMatch(/module is not open/i);

		const start = await post(
			`/quiz/lessons/${lockedAssessmentLessonId}/assessment/start`,
			tokens[STUDENT_AUTH] as string,
		);
		expect(start.status).toBe(403);
		expect(JSON.stringify(await start.json())).toMatch(/module is not open/i);

		const session = await get(
			`/quiz/lessons/${lockedAssessmentLessonId}/assessment/session`,
			tokens[STUDENT_AUTH] as string,
		);
		expect(session.status).toBe(403);
		expect(JSON.stringify(await session.json())).toMatch(/module is not open/i);
	});

	it("changes nothing at all when it refuses", async () => {
		const progress = await one(
			`SELECT count(*)::int AS n FROM lesson_progress WHERE lesson_id = ${lockedTextLessonId}`,
		);
		const attempts = await one(
			`SELECT count(*)::int AS n FROM quiz_attempts WHERE lesson_id = ${lockedQuizLessonId}`,
		);
		const sessions = await one(
			`SELECT count(*)::int AS n FROM assessment_sessions WHERE lesson_id = ${lockedAssessmentLessonId}`,
		);
		const enrollment = await one(
			`SELECT progress_percent FROM enrollments WHERE id = ${enrollmentId}`,
		);

		expect(progress.n).toBe(0);
		expect(attempts.n).toBe(0);
		expect(sessions.n).toBe(0);
		expect(Number(enrollment.progress_percent)).toBe(0);
	});

	it("still lets the student complete a lesson in a module that is open", async () => {
		const res = await patch(
			`/enrollments/${enrollmentId}/progress/${openLessonId}`,
			tokens[STUDENT_AUTH] as string,
			{ completed: true },
		);
		expect(res.status).toBe(200);
	});
});

describe("setting the date", () => {
	it("stores midnight in Lagos for a bare date, and clears on null", async () => {
		const set = await patch(`/modules/${openModuleId}`, tokens[OWNER_AUTH] as string, {
			unlockAt: "2026-10-19",
		});
		expect(set.status).toBe(200);
		expect(new Date(await unlockAtOf(openModuleId)).toISOString()).toBe(
			"2026-10-18T23:00:00.000Z",
		);

		const cleared = await patch(`/modules/${openModuleId}`, tokens[OWNER_AUTH] as string, {
			unlockAt: null,
		});
		expect(cleared.status).toBe(200);
		expect(await unlockAtOf(openModuleId)).toBeNull();
	});

	it("refuses a date it cannot read, and a stranger, without touching the row", async () => {
		const before = await unlockAtOf(openModuleId);

		const bad = await patch(`/modules/${openModuleId}`, tokens[OWNER_AUTH] as string, {
			unlockAt: "next tuesday",
		});
		expect(bad.status).toBe(400);
		expect(await unlockAtOf(openModuleId)).toBe(before);

		const stranger = await patch(
			`/modules/${openModuleId}`,
			tokens[OTHER_AUTH] as string,
			{
				unlockAt: "2026-10-19",
			},
		);
		expect(stranger.status).toBe(403);
		expect(await unlockAtOf(openModuleId)).toBe(before);
	});

	it("leaves the date alone when the save does not mention it", async () => {
		await patch(`/modules/${openModuleId}`, tokens[OWNER_AUTH] as string, {
			unlockAt: "2026-10-19",
		});
		await patch(`/modules/${openModuleId}`, tokens[OWNER_AUTH] as string, {
			title: "Renamed",
		});

		expect(new Date(await unlockAtOf(openModuleId)).toISOString()).toBe(
			"2026-10-18T23:00:00.000Z",
		);
	});

	it("revokes access for a student who already finished a lesson in it", async () => {
		/* Open the door, complete the lesson, then close it. */
		await patch(`/modules/${openModuleId}`, tokens[OWNER_AUTH] as string, {
			unlockAt: null,
		});
		const before = await patch(
			`/enrollments/${enrollmentId}/progress/${openLessonId}`,
			tokens[STUDENT_AUTH] as string,
			{ completed: true },
		);
		expect(before.status).toBe(200);

		const progressBefore = (await one(
			`SELECT progress_percent FROM enrollments WHERE id = ${enrollmentId}`,
		))?.progress_percent;

		await patch(`/modules/${openModuleId}`, tokens[OWNER_AUTH] as string, {
			unlockAt: "2026-10-19",
		});

		const after = await patch(
			`/enrollments/${enrollmentId}/progress/${openLessonId}`,
			tokens[STUDENT_AUTH] as string,
			{ completed: true },
		);
		expect(after.status).toBe(403);
		expect(JSON.stringify(await after.json())).toMatch(/module is not open/i);

		const reads = await get(
			`/modules/${openModuleId}/lessons`,
			tokens[STUDENT_AUTH] as string,
		);
		const rows = await lessonsOf(reads);
		expect(Object.keys(rows[0]).sort()).toEqual(STUB_KEYS);

		/* @info - Locking a module revokes access but must not quietly move a student's
		 * own progress: what they finished, they keep. */
		const progressAfter = (await one(
			`SELECT progress_percent FROM enrollments WHERE id = ${enrollmentId}`,
		))?.progress_percent;
		expect(String(progressAfter)).toBe(String(progressBefore));
	});
});
