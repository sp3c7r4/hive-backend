import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { courses } from "@/modules/courses/course.model";
import { courseEnrollmentCount } from "@/modules/enrollments/enrollment-count";

/**
 * @info - The definition of "a counted student", from the 2026-10-08 spec.
 * courses.enrollment_count is dead (created at 0, never written), so this is the
 * only rule that decides what the UI reports.
 */

const M = "enr-count";
const DB_READY = (async () => {
	connectPostgresDB(() => {});
	return getDb();
})();

let db: Awaited<typeof DB_READY>;
let freeCourseId = 0;
let paidCourseId = 0;

/* @info - first row of a raw query, so the fixture reads without index checks */
const first = async (q: any): Promise<any> => (await db.execute(q)).rows[0];

const cleanup = async () => {
	await db.execute(sql`delete from payments where reference like ${`${M}-%`}`);
	await db.execute(
		sql`delete from enrollments where course_id in (select id from courses where slug like ${`${M}-%`})`,
	);
	await db.execute(sql`delete from courses where slug like ${`${M}-%`}`);
	await db.execute(sql`delete from communities where slug like ${`${M}-%`}`);
	await db.execute(
		sql`delete from user_roles where user_id in (select id from users where email like ${`${M}-%`})`,
	);
	await db.execute(sql`delete from users where email like ${`${M}-%`}`);
};

const seed = async () => {
	await db.execute(sql`
		insert into users (first_name, last_name, email, onboarded)
		values ('Count', 'Owner', ${`${M}-owner@hive.test`}, true),
		       ('Count', 'A', ${`${M}-a@hive.test`}, true),
		       ('Count', 'B', ${`${M}-b@hive.test`}, true),
		       ('Count', 'C', ${`${M}-c@hive.test`}, true),
		       ('Count', 'D', ${`${M}-d@hive.test`}, true),
		       ('Count', 'E', ${`${M}-e@hive.test`}, true),
		       ('Count', 'F', ${`${M}-f@hive.test`}, true),
		       ('Count', 'G', ${`${M}-g@hive.test`}, true)
	`);
	await db.execute(sql`
		insert into user_roles (user_id, role)
		select id, 'instructor'::user_role from users where email = ${`${M}-owner@hive.test`}
	`);
	await db.execute(sql`
		insert into user_roles (user_id, role)
		select id, 'student'::user_role from users where email like ${`${M}-%@hive.test`} and email <> ${`${M}-owner@hive.test`}
	`);
	await db.execute(sql`
		insert into communities (name, slug, owner_id)
		select 'Count Community', ${`${M}-community`}, id from users where email = ${`${M}-owner@hive.test`}
	`);
	const communityId = (
		await first(
			sql`select id from communities where slug = ${`${M}-community`}`,
		)
	).id;
	const ownerId = (
		await first(
			sql`select id from users where email = ${`${M}-owner@hive.test`}`,
		)
	).id;

	const course = async (slug: string, price: number, isFree: boolean) =>
		(
			await first(sql`
			insert into courses (instructor_id, community_id, title, slug, price, is_free, status)
			values (${ownerId}, ${communityId}, ${slug}, ${slug}, ${price}, ${isFree}, 'published')
			returning id
		`)
		).id;

	freeCourseId = await course(`${M}-free`, 0, true);
	paidCourseId = await course(`${M}-paid`, 50000, false);

	const student = async (email: string) =>
		(
			await first(
				sql`select id from users where email = ${`${M}-${email}@hive.test`}`,
			)
		).id;

	const enrol = async (
		courseId: number,
		email: string,
		enrolledBy: number | null = null,
		deleted = false,
	) =>
		(
			await first(sql`
			insert into enrollments (user_id, course_id, enrolled_by_id, deleted_at)
			values (${await student(email)}, ${courseId}, ${enrolledBy}, ${deleted ? sql`now()` : sql`null`})
			returning id
		`)
		).id;

	const pay = async (
		enrollmentId: number,
		courseId: number,
		payerId: number,
		status: string,
	) =>
		db.execute(sql`
			insert into payments (payer_id, payer_role, enrollment_id, course_id, amount, status, type, reference)
			values (${payerId}, 'student'::user_role, ${enrollmentId}, ${courseId}, 50000, ${status}::payment_status,
			        'enrollment'::payment_type, ${`${M}-${status}-${enrollmentId}`})
		`);

	/* free course: one student, no payment needed */
	await enrol(freeCourseId, "a");

	/* paid course: paid, staff added, then pending, failed, refunded, soft deleted */
	const b = await enrol(paidCourseId, "b");
	await pay(b, paidCourseId, await student("b"), "success");
	await enrol(paidCourseId, "f", ownerId);

	const c = await enrol(paidCourseId, "c");
	await pay(c, paidCourseId, await student("c"), "pending");

	const d = await enrol(paidCourseId, "d");
	await pay(d, paidCourseId, await student("d"), "failed");

	const e2 = await enrol(paidCourseId, "e");
	await pay(e2, paidCourseId, await student("e"), "refunded");

	await enrol(paidCourseId, "g", null, true);
};

const countFor = async (courseId: number): Promise<number> => {
	const rows = await db
		.select({ enrollmentCount: courseEnrollmentCount() })
		.from(courses)
		.where(sql`${courses.id} = ${courseId}`);
	return Number(rows[0]?.enrollmentCount ?? 0);
};

describe("courseEnrollmentCount", () => {
	beforeAll(async () => {
		db = await DB_READY;
		await cleanup();
		await seed();
	}, 60_000);

	afterAll(async () => {
		await cleanup();
	});

	it("counts a free course's students", async () => {
		expect(await countFor(freeCourseId)).toBe(1);
	});

	it("counts a paid course's paid and staff-added students, and nobody else", async () => {
		/* paid (success) + staff added = 2. Not counted: pending, failed, refunded, soft deleted */
		expect(await countFor(paidCourseId)).toBe(2);
	});

	it("does not read the dead courses.enrollment_count column", async () => {
		const dead = await first(
			sql`select enrollment_count from courses where id = ${paidCourseId}`,
		);
		expect(Number(dead.enrollment_count)).toBe(0);
		expect(await countFor(paidCourseId)).toBe(2);
	});
});
