import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPostgresDB, getDb } from "@/db/postgres.db";

/**
 * @info - Regression for migration 0028's backfill correlation.
 *
 * The backfill must link every lesson to ITS OWN session. Correlating on content
 * (course + title + starts_at) is ambiguous: two lessons in one course can share a
 * title at the same time - or at both-null times - and UPDATE ... FROM picks
 * between candidates nondeterministically. A swapped pair still satisfies the
 * unique index, because each lesson ends up with a distinct, valid session id, so
 * the only assertion that catches it is a per-lesson one on the values a swap
 * exchanges: meeting_url, description, duration_minutes.
 *
 * The statements are read from the real migration file, because the migration
 * itself drops the columns it reads - so the fixture schema mirrors the pre-0028
 * shape of lessons and its neighbours. The destructive block is skipped and
 * asserted to still be present.
 */

const MIGRATION_PATH = join(
	process.cwd(),
	"src/db/migrations/0028_live_sessions.sql",
);

/** Throwaway schema: nothing here can touch a real table. */
const SCHEMA = "live_backfill_fixture";

const FIXTURE_DDL = [
	`CREATE TABLE users (
		id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
		first_name text
	)`,
	`CREATE TABLE communities (
		id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
		owner_id integer NOT NULL,
		name text,
		slug text
	)`,
	`CREATE TABLE courses (
		id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
		instructor_id integer NOT NULL,
		community_id integer NOT NULL,
		title text,
		slug text
	)`,
	`CREATE TABLE modules (
		id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
		course_id integer NOT NULL,
		title text
	)`,
	`CREATE TABLE lessons (
		id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
		module_id integer NOT NULL,
		title varchar(255) NOT NULL,
		description text,
		meeting_type text NOT NULL DEFAULT 'none',
		meeting_url varchar(1000),
		scheduled_at timestamptz,
		live_status text NOT NULL DEFAULT 'scheduled',
		duration_minutes integer NOT NULL DEFAULT 60,
		live_meeting_link varchar(1000),
		live_meeting_date varchar(255)
	)`,
];

const AT = "2026-11-15T12:00:00.000Z";

/* @info - Fixtures, in insert order; the first two and the next two are the
 * collision pairs this test exists for (same title + same, or both-null, time). */
const FIXTURE_LESSONS = [
	{
		key: "qa-native",
		title: "Live Q&A",
		description: "native pair member",
		meeting_type: "native",
		meeting_url: null,
		scheduled_at: `'${AT}'`,
		duration_minutes: 45,
		live_meeting_link: null,
		live_status: "scheduled",
	},
	{
		key: "qa-external",
		title: "Live Q&A",
		description: "external pair member",
		meeting_type: "external",
		meeting_url: "'https://meet.example/pair-b'",
		scheduled_at: `'${AT}'`,
		duration_minutes: 90,
		live_meeting_link: null,
		live_status: "scheduled",
	},
	{
		key: "null-a",
		title: "Unscheduled Office Hours",
		description: "null-time pair member A",
		meeting_type: "native",
		meeting_url: null,
		scheduled_at: null,
		duration_minutes: 30,
		live_meeting_link: null,
		live_status: "scheduled",
	},
	{
		key: "null-b",
		title: "Unscheduled Office Hours",
		description: "null-time pair member B",
		meeting_type: "native",
		meeting_url: null,
		scheduled_at: null,
		duration_minutes: 120,
		live_meeting_link: null,
		live_status: "scheduled",
	},
	{
		key: "legacy-url",
		title: "Legacy Link Session",
		description: "url only in the legacy column",
		meeting_type: "external",
		meeting_url: null,
		scheduled_at: `'${AT}'`,
		duration_minutes: 60,
		live_meeting_link: "'https://legacy.example/only-here'",
		live_status: "scheduled",
	},
	{
		key: "ended",
		title: "Already Finished",
		description: null,
		meeting_type: "native",
		meeting_url: null,
		scheduled_at: `'${AT}'`,
		duration_minutes: 60,
		live_meeting_link: null,
		live_status: "ended",
	},
	{
		key: "plain",
		title: "Not A Meeting",
		description: null,
		meeting_type: "none",
		meeting_url: null,
		scheduled_at: null,
		duration_minutes: 60,
		live_meeting_link: null,
		live_status: "scheduled",
	},
];

/** Split the migration into commands the way the runner does. */
const dropColumnRe = (name: string) => new RegExp(`DROP COLUMN "?${name}"?`, "i");
const dropTypeRe = (name: string) => new RegExp(`DROP TYPE "?${name}"?`, "i");

const splitCommands = () => {
	const sql = readFileSync(MIGRATION_PATH, "utf8");
	const chunks = sql
		.split("--> statement-breakpoint")
		.map((c) => c.trim())
		.filter(Boolean);

	const destructiveIndex = chunks.findIndex((c) =>
		dropColumnRe("live_meeting_link").test(c),
	);
	if (destructiveIndex < 0) {
		throw new Error(
			"migration 0028 has no destructive block - this test's split is stale",
		);
	}

	const tempColumnChunk = (pattern: RegExp) => {
		const index = chunks.findIndex((c) => pattern.test(c));
		if (index < 0) {
			throw new Error(
				"migration 0028 changed shape - the backfill replay slice is stale",
			);
		}
		return index;
	};

	/* every chunk may hold several commands; run them one at a time so nothing
	 * depends on the driver's simple-vs-extended query protocol */
	const toCommands = (list: string[]) =>
		list
			.flatMap((chunk) => chunk.split(";"))
			.map((s) => s.trim())
			.filter((s) => s && !s.split("\n").every((line) => line.startsWith("--")));

	const tempAdd = tempColumnChunk(/ADD COLUMN IF NOT EXISTS "?_src_lesson_id/i);
	const tempDrop = tempColumnChunk(/DROP COLUMN IF EXISTS "?_src_lesson_id/i);

	return {
		forward: toCommands(chunks.slice(0, destructiveIndex)),
		/* the data steps plus the guarded add/drop of the correlation column, so the
		 * replay exercises the re-runnability the migration claims */
		backfillReplay: toCommands(chunks.slice(tempAdd, tempDrop + 1)),
		destructive: toCommands(chunks.slice(destructiveIndex)),
	};
};

type SessionRow = {
	lesson_id: number;
	lesson_title: string;
	session_id: number | null;
	kind: string | null;
	community_id: number | null;
	course_id: number | null;
	host_id: number | null;
	session_title: string | null;
	description: string | null;
	meeting_url: string | null;
	starts_at: string | null;
	duration_minutes: number | null;
	status: string | null;
};

describe("migration 0028 backfill correlation", () => {
	let db: ReturnType<typeof getDb>;
	let commands: ReturnType<typeof splitCommands>;
	let hostId: number;
	let communityId: number;
	let courseId: number;
	let nativeLessonId: number;

	/** lesson ids by fixture key, so assertions never depend on insert order */
	const lessonIdByKey = new Map<string, number>();

	beforeAll(async () => {
		await connectPostgresDB(() => {});
		db = getDb();
		commands = splitCommands();

		await db.transaction(async (tx) => {
			await tx.execute(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
			await tx.execute(`CREATE SCHEMA ${SCHEMA}`);
			await tx.execute(`SET LOCAL search_path TO ${SCHEMA}`);

			for (const ddl of FIXTURE_DDL) await tx.execute(ddl);

			const user = await tx.execute(
				`INSERT INTO users (first_name) VALUES ('Fixture') RETURNING id`,
			);
			hostId = Number((user.rows[0] as { id: number }).id);

			const community = await tx.execute(
				`INSERT INTO communities (owner_id, name, slug)
				 VALUES (${hostId}, 'Fixture Community', 'fixture-community') RETURNING id`,
			);
			communityId = Number((community.rows[0] as { id: number }).id);

			const course = await tx.execute(
				`INSERT INTO courses (instructor_id, community_id, title, slug)
				 VALUES (${hostId}, ${communityId}, 'Fixture Course', 'fixture-course') RETURNING id`,
			);
			courseId = Number((course.rows[0] as { id: number }).id);

			const mod = await tx.execute(
				`INSERT INTO modules (course_id, title)
				 VALUES (${courseId}, 'Fixture Module') RETURNING id`,
			);
			const moduleId = Number((mod.rows[0] as { id: number }).id);

			for (const lesson of FIXTURE_LESSONS) {
				const inserted = await tx.execute(
					`INSERT INTO lessons (module_id, title, description, meeting_type, meeting_url,
					                     scheduled_at, live_status, duration_minutes, live_meeting_link)
					 VALUES (${moduleId}, '${lesson.title}', ${lesson.description ? `'${lesson.description}'` : "NULL"},
					         '${lesson.meeting_type}', ${lesson.meeting_url ?? "NULL"},
					         ${lesson.scheduled_at ?? "NULL"}, '${lesson.live_status}', ${lesson.duration_minutes},
					         ${lesson.live_meeting_link ?? "NULL"})
					 RETURNING id`,
				);
				const id = Number((inserted.rows[0] as { id: number }).id);
				lessonIdByKey.set(lesson.key, id);
				if (lesson.key === "qa-native") nativeLessonId = id;
			}

			for (const command of commands.forward) await tx.execute(command);
		});
	});

	afterAll(async () => {
		await db.execute(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
	});

	const readSessions = async (): Promise<SessionRow[]> => {
		const result = await db.execute(
			`SELECT l.id AS lesson_id, l.title AS lesson_title,
			        s.id AS session_id, s.kind, s.community_id, s.course_id, s.host_id,
			        s.title AS session_title, s.description, s.meeting_url, s.starts_at,
			        s.duration_minutes, s.status
			 FROM ${SCHEMA}.lessons l
			 LEFT JOIN ${SCHEMA}.live_sessions s ON s.id = l.live_session_id
			 ORDER BY l.id`,
		);
		return result.rows as unknown as SessionRow[];
	};

	const rowFor = (rows: SessionRow[], lessonId: number) => {
		const row = rows.find((r) => Number(r.lesson_id) === lessonId);
		if (!row) throw new Error(`no fixture row for lesson ${lessonId}`);
		return row;
	};

	it("links every meeting lesson to its own session (collision pairs included)", async () => {
		const rows = await readSessions();

		/* the native half of the same-title/same-time pair */
		const native = rowFor(rows, lessonIdByKey.get("qa-native")!);
		expect(native.session_id).not.toBeNull();
		expect(native.kind).toBe("native");
		expect(native.description).toBe("native pair member");
		expect(native.duration_minutes).toBe(45);
		expect(native.session_title).toBe("Live Q&A");

		/* the external half keeps its own url - a swap would hand it the other row's */
		const external = rowFor(rows, lessonIdByKey.get("qa-external")!);
		expect(external.session_id).not.toBeNull();
		expect(external.session_id).not.toBe(native.session_id);
		expect(external.kind).toBe("external");
		expect(external.description).toBe("external pair member");
		expect(external.duration_minutes).toBe(90);
		expect(external.meeting_url).toBe("https://meet.example/pair-b");

		/* the both-null-starts_at pair is the same hazard with no time to match on */
		const nullA = rowFor(rows, lessonIdByKey.get("null-a")!);
		const nullB = rowFor(rows, lessonIdByKey.get("null-b")!);
		expect(nullA.session_id).not.toBeNull();
		expect(nullB.session_id).not.toBeNull();
		expect(nullA.session_id).not.toBe(nullB.session_id);
		expect(nullA.description).toBe("null-time pair member A");
		expect(nullA.duration_minutes).toBe(30);
		expect(nullB.description).toBe("null-time pair member B");
		expect(nullB.duration_minutes).toBe(120);
	});

	it("carries scope, schedule and status across", async () => {
		const rows = await readSessions();
		const native = rowFor(rows, lessonIdByKey.get("qa-native")!);
		expect(native.community_id).toBe(communityId);
		expect(native.course_id).toBe(courseId);
		expect(native.host_id).toBe(hostId);
		expect(new Date(native.starts_at!).toISOString()).toBe(AT);
		expect(native.status).toBe("scheduled");

		const ended = rowFor(rows, lessonIdByKey.get("ended")!);
		expect(ended.status).toBe("ended");
	});

	it("takes the meeting url from the legacy column when meeting_url is empty", async () => {
		const rows = await readSessions();
		const legacy = rowFor(rows, lessonIdByKey.get("legacy-url")!);
		expect(legacy.kind).toBe("external");
		expect(legacy.meeting_url).toBe("https://legacy.example/only-here");
	});

	it("leaves non-meeting lessons without a session", async () => {
		const rows = await readSessions();
		expect(rowFor(rows, lessonIdByKey.get("plain")!).session_id).toBeNull();
	});

	it("creates exactly one session per meeting lesson", async () => {
		const rows = await readSessions();
		const meetingLessons = FIXTURE_LESSONS.filter(
			(l) => l.meeting_type !== "none",
		);
		const counts = await db.execute(
			`SELECT count(*)::int AS total FROM ${SCHEMA}.live_sessions`,
		);
		expect(Number((counts.rows[0] as { total: number }).total)).toBe(
			meetingLessons.length,
		);
		const linked = rows.filter((r) => r.session_id !== null);
		expect(linked).toHaveLength(meetingLessons.length);
	});

	it("drops the correlation column it used", async () => {
		const columns = await db.execute(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_schema = '${SCHEMA}' AND table_name = 'live_sessions'`,
		);
		const names = (columns.rows as unknown as { column_name: string }[]).map(
			(r) => r.column_name,
		);
		expect(names).toContain("kind");
		expect(names).not.toContain("_src_lesson_id");
	});

	it("is a no-op when the data statements are replayed", async () => {
		const before = await readSessions();
		const beforeCount = await db.execute(
			`SELECT count(*)::int AS total FROM ${SCHEMA}.live_sessions`,
		);

		await db.transaction(async (tx) => {
			await tx.execute(`SET LOCAL search_path TO ${SCHEMA}`);
			for (const command of commands.backfillReplay) {
				await tx.execute(command);
			}
		});

		const after = await readSessions();
		const afterCount = await db.execute(
			`SELECT count(*)::int AS total FROM ${SCHEMA}.live_sessions`,
		);
		expect(Number((afterCount.rows[0] as { total: number }).total)).toBe(
			Number((beforeCount.rows[0] as { total: number }).total),
		);
		expect(after.map((r) => r.session_id)).toEqual(
			before.map((r) => r.session_id),
		);
		expect(after.map((r) => r.meeting_url)).toEqual(
			before.map((r) => r.meeting_url),
		);
	});

	it("still drops the legacy lesson columns and enums", () => {
		const destructiveSql = commands.destructive.join("\n");
		for (const column of [
			"live_meeting_link",
			"live_meeting_date",
			"meeting_type",
			"meeting_url",
			"scheduled_at",
			"live_status",
			"duration_minutes",
		]) {
			expect(destructiveSql).toMatch(dropColumnRe(column));
		}
		expect(destructiveSql).toMatch(dropTypeRe("lesson_meeting_type"));
		expect(destructiveSql).toMatch(dropTypeRe("lesson_live_status"));
	});

	it("keeps the unique index that guards one session per lesson", async () => {
		const future = await db.execute(
			`SELECT indexname FROM pg_indexes
			 WHERE schemaname = '${SCHEMA}' AND indexname = 'uq_lessons_live_session'`,
		);
		expect(future.rows).toHaveLength(1);

		/* a second link for the same lesson must be rejected */
		let failure = "";
		try {
			await db.execute(
				`UPDATE ${SCHEMA}.lessons SET live_session_id = (
					SELECT id FROM ${SCHEMA}.live_sessions WHERE id <> (
						SELECT live_session_id FROM ${SCHEMA}.lessons WHERE id = ${nativeLessonId}
					) LIMIT 1
				 ) WHERE id = ${nativeLessonId}`,
			);
		} catch (error) {
			const e = error as { message?: string; cause?: { message?: string } };
			failure = `${e.message ?? ""} ${e.cause?.message ?? ""}`;
		}
		expect(failure).toMatch(/uq_lessons_live_session|duplicate key/i);
	});
});
