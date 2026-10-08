import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { EarningsService } from "@/modules/earnings/earnings.service";
import { InstructorService } from "@/modules/instructor/instructor.service";

/**
 * @info - The dashboard's numbers, from the 2026-10-08 spec.
 * The two counting rules the spec corrects are asserted here, together with the parity
 * between the two "this month" figures and the donut's reconciliation with the card.
 */

const M = "dash-metrics";
const DB_READY = (async () => {
	connectPostgresDB(() => {});
	return getDb();
})();

let db: Awaited<typeof DB_READY>;
let ownerId = 0;
let emptyOwnerId = 0;

const first = async (q: any): Promise<any> => (await db.execute(q)).rows[0];

const cleanup = async () => {
	await db.execute(sql`delete from lesson_progress where enrollment_id in (
		select id from enrollments where course_id in (select id from courses where slug like ${`${M}-%`}))`);
	await db.execute(sql`delete from enrollments where course_id in (select id from courses where slug like ${`${M}-%`})`);
	await db.execute(sql`delete from lessons where module_id in (select id from modules where course_id in (select id from courses where slug like ${`${M}-%`}))`);
	await db.execute(sql`delete from modules where course_id in (select id from courses where slug like ${`${M}-%`})`);
	await db.execute(sql`delete from courses where slug like ${`${M}-%`}`);
	await db.execute(sql`delete from community_members where community_id in (select id from communities where slug like ${`${M}-%`})`);
	await db.execute(sql`delete from communities where slug like ${`${M}-%`}`);
	await db.execute(sql`delete from instructor_transactions where reference like ${`${M}-%`}`);
	await db.execute(sql`delete from instructor_balances where instructor_id in (select id from users where email like ${`${M}-%`})`);
	await db.execute(sql`delete from user_roles where user_id in (select id from users where email like ${`${M}-%`})`);
	await db.execute(sql`delete from users where email like ${`${M}-%`}`);
};

const seed = async () => {
	await db.execute(sql`
		insert into users (first_name, last_name, email, onboarded)
		values ('Dash', 'Owner', ${`${M}-owner@hive.test`}, true),
		       ('Dash', 'Empty', ${`${M}-empty@hive.test`}, true),
		       ('Dash', 'Student', ${`${M}-student@hive.test`}, true),
		       ('Dash', 'One', ${`${M}-one@hive.test`}, true),
		       ('Dash', 'Two', ${`${M}-two@hive.test`}, true),
		       ('Dash', 'Three', ${`${M}-three@hive.test`}, true)
	`);
	await db.execute(sql`
		insert into user_roles (user_id, role)
		select id, 'instructor'::user_role from users where email in (${`${M}-owner@hive.test`}, ${`${M}-empty@hive.test`})`);
	await db.execute(sql`
		insert into user_roles (user_id, role)
		select id, 'student'::user_role from users where email like ${`${M}-%`}
		  and email not in (${`${M}-owner@hive.test`}, ${`${M}-empty@hive.test`})`);

	ownerId = (await first(sql`select id from users where email = ${`${M}-owner@hive.test`}`)).id;
	emptyOwnerId = (await first(sql`select id from users where email = ${`${M}-empty@hive.test`}`)).id;
	const uid = async (who: string) =>
		(await first(sql`select id from users where email = ${`${M}-${who}@hive.test`}`)).id;

	/* communities owned by the owner: one with a long name, one smaller, one with nobody */
	await db.execute(sql`
		insert into communities (name, slug, owner_id)
		values ('Arthurite Integrated Smart Commerce and Creative Skills Training Scheme Community', ${`${M}-long`}, ${ownerId}),
		       ('Dash Second', ${`${M}-two`}, ${ownerId}),
		       ('Dash Empty', ${`${M}-three`}, ${ownerId})`);
	const comm = async (slug: string) =>
		(await first(sql`select id from communities where slug = ${`${M}-${slug}`}`)).id;
	const longId = await comm("long");
	const twoId = await comm("two");

	/* memberships: 3 active + 1 pending on the long one, 2 active on the second, none on the third */
	await db.execute(sql`
		insert into community_members (community_id, user_id, role, status)
		values (${longId}, ${await uid("student")}, 'student'::user_role, 'active'),
		       (${longId}, ${await uid("one")}, 'student'::user_role, 'active'),
		       (${longId}, ${await uid("two")}, 'student'::user_role, 'active'),
		       (${longId}, ${await uid("three")}, 'student'::user_role, 'pending'),
		       (${twoId}, ${await uid("one")}, 'student'::user_role, 'active'),
		       (${twoId}, ${await uid("two")}, 'student'::user_role, 'active')`);
	const count = async (slug: string) =>
		(await first(sql`select id from communities where slug = ${`${M}-${slug}`}`)).id;

	/* courses: one paid, one free. The same student is in both, which is what makes the
	 * distinct rule matter (2 enrolments, 1 person). */
	const course = async (slug: string, price: number, isFree: boolean, communityId: number) =>
		(await first(sql`
			insert into courses (instructor_id, community_id, title, slug, price, is_free, status)
			values (${ownerId}, ${communityId}, ${slug}, ${slug}, ${price}, ${isFree}, 'published')
			returning id`)).id;
	const paidCourseId = await course(`${M}-paid`, 50000, false, await count("long"));
	const freeCourseId = await course(`${M}-free`, 0, true, await count("two"));

	const enrol = async (courseId: number) =>
		(await first(sql`
			insert into enrollments (user_id, course_id, progress_percent)
			values (${await uid("student")}, ${courseId}, 0)
			returning id`)).id;
	const paidEnrolmentId = await enrol(paidCourseId);
	await enrol(freeCourseId);

	/* 10 lessons, all touched by that one student: 10 lesson rows, 1 active student */
	const moduleId = (await first(sql`
		insert into modules (course_id, title, sort_order)
		values (${paidCourseId}, 'Dash Module', 0)
		returning id`)).id;
	for (let i = 0; i < 10; i++) {
		const lessonId = (await first(sql`
			insert into lessons (module_id, title, type, sort_order, status)
			values (${moduleId}, ${`Dash Lesson ${i}`}, 'video', ${i}, 'published')
			returning id`)).id;
		await db.execute(sql`
			insert into lesson_progress (enrollment_id, lesson_id, completed)
			values (${paidEnrolmentId}, ${lessonId}, false)`);
	}

	/* ledger: two credits this month (enrollment + community), one older credit, one debit */
	await db.execute(sql`
		insert into instructor_transactions (instructor_id, type, category, amount, balance_after, reference)
		values (${ownerId}, 'credit'::instructor_tx_type, 'enrollment'::instructor_tx_category, 30000, 30000, ${`${M}-c1`}),
		       (${ownerId}, 'credit'::instructor_tx_type, 'community'::instructor_tx_category, 20000, 50000, ${`${M}-c2`}),
		       (${ownerId}, 'debit'::instructor_tx_type, 'withdrawal'::instructor_tx_category, 5000, 45000, ${`${M}-d1`})`);
	await db.execute(sql`
		insert into instructor_transactions (instructor_id, type, category, amount, balance_after, reference, created_at)
		values (${ownerId}, 'credit'::instructor_tx_type, 'enrollment'::instructor_tx_category, 10000, 10000, ${`${M}-c3`},
		        now() - interval '40 days')`);
	await db.execute(sql`
		insert into instructor_balances (instructor_id, available, withdrawn)
		values (${ownerId}, 45000, 5000)`);
};

const ownerAuth = () => ({ id: ownerId, roles: ["instructor"] }) as any;

describe("instructor dashboard metrics", () => {
	beforeAll(async () => {
		db = await DB_READY;
		await cleanup();
		await seed();
	}, 90_000);

	afterAll(async () => {
		await cleanup();
	});

	it("AC1: counts active students as people, not lesson rows", async () => {
		const dash = await EarningsService.getInstance().dashboard(ownerAuth());
		/* 10 lesson rows behind 1 person. The old count() returned 10. */
		expect(dash.activeStudents7d).toBe(1);
	});

	it("AC2: counts total students as people, not enrolments", async () => {
		const stats = await InstructorService.getInstance().getStats(ownerAuth());
		/* 2 enrolments behind 1 person. The old count() returned 2. */
		expect(stats.totalStudents).toBe(1);
	});

	it("AC3: Total Earnings is the ledger, and this month is the calendar month inside it", async () => {
		const svc = EarningsService.getInstance();
		const dash = await svc.dashboard(ownerAuth());
		expect(dash.summary.totalEarned).toBe(60000);
		expect(dash.summary.thisMonth).toBe(50000);
		expect(dash.summary.available).toBe(45000);
	});

	it("AC13: the earnings summary and the dashboard agree on this month, for the same data", async () => {
		const svc = EarningsService.getInstance();
		const dash = await svc.dashboard(ownerAuth());
		const summary = await svc.summary(ownerAuth(), "all");
		expect(summary.thisMonth).toBe(dash.summary.thisMonth);
		expect(summary.totalEarned).toBe(dash.summary.totalEarned);
		/* a period request must not shrink a calendar-month figure */
		const week = await svc.summary(ownerAuth(), "7d");
		expect(week.thisMonth).toBe(dash.summary.thisMonth);
	});

	it("AC5: the Members card, the slices and Other reconcile, and pending does not count", async () => {
		const dash = await EarningsService.getInstance().dashboard(ownerAuth());
		expect(dash.metrics.memberships).toBe(5);
		expect(dash.metrics.communities).toBe(3);
		expect(dash.metrics.courses).toBe(2);
		expect(dash.metrics.students).toBe(1);

		expect(dash.topCommunities).toHaveLength(2);
		expect(dash.topCommunities[0]?.memberships).toBe(3);
		expect(dash.topCommunities[0]?.name).toContain("Arthurite");
		const sliced = dash.topCommunities.reduce((a, r) => a + r.memberships, 0);
		expect(sliced + dash.otherMemberships).toBe(dash.metrics.memberships);
	});

	it("AC8: the trend carries 14 daily and 8 weekly buckets, zero-filled and in order", async () => {
		const dash = await EarningsService.getInstance().dashboard(ownerAuth());
		expect(dash.enrollmentSeries.daily).toHaveLength(14);
		expect(dash.enrollmentSeries.weekly).toHaveLength(8);
		const days = dash.enrollmentSeries.daily.map((d) => d.period);
		expect([...days].sort()).toEqual(days);
		/* both enrolments were made now, so today's bucket carries them */
		expect(dash.enrollmentSeries.daily[13]?.count).toBe(2);
		expect(dash.enrollmentSeries.daily[0]?.count).toBe(0);
	});

	it("AC3: an instructor with no ledger rows reads zero, in numbers the card can word", async () => {
		const dash = await EarningsService.getInstance().dashboard({
			id: emptyOwnerId,
			roles: ["instructor"],
		} as any);
		expect(dash.summary.totalEarned).toBe(0);
		expect(dash.summary.thisMonth).toBe(0);
		expect(dash.metrics).toEqual({
			courses: 0,
			students: 0,
			memberships: 0,
			communities: 0,
		});
		expect(dash.topCommunities).toEqual([]);
		expect(dash.otherMemberships).toBe(0);
		expect(dash.activeStudents7d).toBe(0);
	});
});
