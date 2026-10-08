import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { CourseService } from "@/modules/courses/course.service";

/**
 * @info - A module that has not opened still lists its lessons, but as a strict allowlist
 * of eight keys. The test asserts the exact key set, because the risk here is a leak: the
 * rows are real lesson rows and their content must not ride along.
 * See 2026-10-08-counts-locked-curriculum-bulk-invite-design.md, AC6.
 */

const M = "lock-list";
const LOCKED_KEYS = [
	"duration",
	"id",
	"lockReason",
	"sortOrder",
	"status",
	"title",
	"type",
	"unlockAt",
];

const DB_READY = (async () => {
	connectPostgresDB(() => {});
	return getDb();
})();

let db: Awaited<typeof DB_READY>;
let lockedModuleId = 0;
let openModuleId = 0;
let studentId = 0;
let instructorId = 0;
let unlockAt: Date;

const first = async (q: any): Promise<any> => (await db.execute(q)).rows[0];

const cleanup = async () => {
	await db.execute(
		sql`delete from lesson_progress where lesson_id in (select id from lessons where module_id in (select id from modules where course_id in (select id from courses where slug = ${`${M}-course`})))`,
	);
	await db.execute(
		sql`delete from lessons where module_id in (select id from modules where course_id in (select id from courses where slug = ${`${M}-course`}))`,
	);
	await db.execute(
		sql`delete from modules where course_id in (select id from courses where slug = ${`${M}-course`})`,
	);
	await db.execute(
		sql`delete from enrollments where course_id in (select id from courses where slug = ${`${M}-course`})`,
	);
	await db.execute(sql`delete from courses where slug = ${`${M}-course`}`);
	await db.execute(
		sql`delete from communities where slug = ${`${M}-community`}`,
	);
	await db.execute(
		sql`delete from user_roles where user_id in (select id from users where email like ${`${M}-%`})`,
	);
	await db.execute(sql`delete from users where email like ${`${M}-%`}`);
};

const seed = async () => {
	await db.execute(sql`
		insert into users (first_name, last_name, email, onboarded)
		values ('Lock', 'Tutor', ${`${M}-tutor@hive.test`}, true),
		       ('Lock', 'Student', ${`${M}-student@hive.test`}, true)
	`);
	await db.execute(sql`
		insert into user_roles (user_id, role)
		select id, 'instructor'::user_role from users where email = ${`${M}-tutor@hive.test`}
	`);
	await db.execute(sql`
		insert into user_roles (user_id, role)
		select id, 'student'::user_role from users where email = ${`${M}-student@hive.test`}
	`);
	instructorId = (
		await first(
			sql`select id from users where email = ${`${M}-tutor@hive.test`}`,
		)
	).id;
	studentId = (
		await first(
			sql`select id from users where email = ${`${M}-student@hive.test`}`,
		)
	).id;

	const communityId = (
		await first(sql`
		insert into communities (name, slug, owner_id)
		values ('Lock Community', ${`${M}-community`}, ${instructorId})
		returning id
	`)
	).id;
	const courseId = (
		await first(sql`
		insert into courses (instructor_id, community_id, title, slug, price, is_free, status, visibility)
		values (${instructorId}, ${communityId}, 'Locked Curriculum', ${`${M}-course`}, 0, true, 'published', 'public')
		returning id
	`)
	).id;

	const module = async (
		title: string,
		sortOrder: number,
		unlock: Date | null,
	) =>
		(
			await first(sql`
			insert into modules (course_id, title, sort_order, unlock_at)
			values (${courseId}, ${title}, ${sortOrder}, ${unlock})
			returning id
		`)
		).id;

	unlockAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
	lockedModuleId = await module("Week 2", 0, unlockAt);
	openModuleId = await module("Week 1", 1, null);

	const lesson = async (moduleId: number, title: string, sortOrder: number) =>
		db.execute(sql`
			insert into lessons (module_id, title, description, type, duration, sort_order, status, video_url, settings)
			values (${moduleId}, ${title}, 'secret body text', 'video', 12, ${sortOrder}, 'published',
			        'https://cdn.example.com/secret.mp4', ${JSON.stringify({ secret: true })}::jsonb)
		`);

	for (let i = 0; i < 3; i++)
		await lesson(lockedModuleId, `Locked lesson ${i + 1}`, i);
	await lesson(openModuleId, "Open lesson", 0);

	await db.execute(
		sql`insert into enrollments (user_id, course_id, progress_percent) values (${studentId}, ${courseId}, 0)`,
	);
};

describe("locked module lesson list", () => {
	beforeAll(async () => {
		db = await DB_READY;
		await cleanup();
		await seed();
	}, 60_000);

	afterAll(async () => {
		await cleanup();
	});

	it("lists every lesson of a locked module as exactly the eight allowlisted keys", async () => {
		const rows: any[] = await CourseService.getInstance().listLessons(
			lockedModuleId,
			{
				id: studentId,
				roles: ["student"],
			} as any,
		);

		expect(rows).toHaveLength(3);
		const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
		expect(keys).toEqual(LOCKED_KEYS);
		for (const row of rows) {
			expect(row.status).toBe("locked");
			expect(row.lockReason).toBe("module_not_open");
			expect(new Date(row.unlockAt).getTime()).toBe(unlockAt.getTime());
		}
	});

	it("leaks no lesson content: no body, no url, no settings, no key beyond the allowlist", async () => {
		const { getDb: realDb } = await import("@/db/postgres.db");
		const { lessons } = await import("@/modules/courses/course.model");
		const { eq } = await import("drizzle-orm");
		const [stored] = await realDb()
			.select()
			.from(lessons)
			.where(eq(lessons.moduleId, lockedModuleId))
			.limit(1);
		expect(stored?.description).toBe("secret body text");

		const rows: any[] = await CourseService.getInstance().listLessons(
			lockedModuleId,
			{
				id: studentId,
				roles: ["student"],
			} as any,
		);
		const payload = JSON.stringify(rows);
		expect(payload).not.toContain("secret body text");
		expect(payload).not.toContain("secret.mp4");
		expect(payload).not.toContain("settings");
		expect(payload.includes("videoUrl")).toBe(false);
		expect(payload.includes("description")).toBe(false);
	});

	it("still gives an open module its full lessons, and the instructor the full tree", async () => {
		const svc = CourseService.getInstance();
		const student: any[] = await svc.listLessons(openModuleId, {
			id: studentId,
			roles: ["student"],
		} as any);
		expect(student[0].status).toBe("published");
		expect(student[0].videoUrl).toBeTruthy();

		const tutor: any[] = await svc.listLessons(lockedModuleId, {
			id: instructorId,
			roles: ["instructor"],
		} as any);
		expect(tutor).toHaveLength(3);
		expect(tutor[0].status).toBe("published");
		expect(tutor[0].description).toBe("secret body text");
	});
});
