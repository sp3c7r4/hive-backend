import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import {
	countActiveMembers,
	withActiveMemberCount,
} from "@/modules/communities/community-member-count";

/**
 * @info - communities.member_count is written once, as 1, and never maintained.
 * These are the two reads that replace it.
 */

const M = "mem-count";
const DB_READY = (async () => {
	connectPostgresDB(() => {});
	return getDb();
})();

let db: Awaited<typeof DB_READY>;
let communityId = 0;
let otherId = 0;

const first = async (q: any): Promise<any> => (await db.execute(q)).rows[0];

const cleanup = async () => {
	await db.execute(
		sql`delete from community_members where community_id in (select id from communities where slug like ${`${M}-%`})`,
	);
	await db.execute(sql`delete from communities where slug like ${`${M}-%`}`);
	await db.execute(
		sql`delete from user_roles where user_id in (select id from users where email like ${`${M}-%`})`,
	);
	await db.execute(sql`delete from users where email like ${`${M}-%`}`);
};

const seed = async () => {
	await db.execute(sql`
		insert into users (first_name, last_name, email, onboarded)
		values ('Mem', 'Owner', ${`${M}-owner@hive.test`}, true),
		       ('Mem', 'Active', ${`${M}-active@hive.test`}, true),
		       ('Mem', 'Also', ${`${M}-also@hive.test`}, true),
		       ('Mem', 'Pending', ${`${M}-pending@hive.test`}, true)
	`);
	const ownerId = (
		await first(
			sql`select id from users where email = ${`${M}-owner@hive.test`}`,
		)
	).id;
	const userId = async (who: string) =>
		(
			await first(
				sql`select id from users where email = ${`${M}-${who}@hive.test`}`,
			)
		).id;

	communityId = (
		await first(sql`
		insert into communities (name, slug, owner_id, member_count)
		values ('Mem Community', ${`${M}-one`}, ${ownerId}, 1)
		returning id
	`)
	).id;
	otherId = (
		await first(sql`
		insert into communities (name, slug, owner_id, member_count)
		values ('Mem Empty', ${`${M}-two`}, ${ownerId}, 1)
		returning id
	`)
	).id;

	await db.execute(sql`
		insert into community_members (community_id, user_id, role, status)
		values (${communityId}, ${await userId("active")}, 'student'::user_role, 'active'),
		       (${communityId}, ${await userId("also")}, 'student'::user_role, 'active'),
		       (${communityId}, ${await userId("pending")}, 'student'::user_role, 'pending')
	`);
};

describe("community member count", () => {
	beforeAll(async () => {
		db = await DB_READY;
		await cleanup();
		await seed();
	}, 60_000);

	afterAll(async () => {
		await cleanup();
	});

	it("counts active members only, and reports zero for a community with none", async () => {
		const counts = await countActiveMembers([communityId, otherId]);
		expect(counts.get(communityId)).toBe(2);
		expect(counts.get(otherId) ?? 0).toBe(0);
	});

	it("replaces the stale column on a row", async () => {
		const row = await first(
			sql`select * from communities where id = ${communityId}`,
		);
		expect(row.member_count).toBe(1); /* the dead column, kept for now */
		const counted = await withActiveMemberCount(row as { id: number });
		expect(counted.memberCount).toBe(2);
	});
});
