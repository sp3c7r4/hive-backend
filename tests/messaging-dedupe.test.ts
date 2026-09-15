import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { config } from "@/config";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { MessagingRepository } from "@/modules/messaging/messaging.repository";

/**
 * @info - Conversations must collapse onto one row per subject even when callers
 * race. GET /messages/conversations fires twice under React StrictMode and used
 * to create a second group chat per community (SELECT-then-INSERT with no
 * constraint); "New Message" had the same gap for direct threads.
 *
 * Covers both halves of migration 0026: the merge of duplicates that already
 * exist, and the partial unique index that stops new ones. Expects a migrated
 * database (npm run migrate) — the index assertion says so if you forgot.
 */
describe("Messaging conversation de-duplication", () => {
	const repo = MessagingRepository.getInstance();
	let db: ReturnType<typeof getDb>;
	let pool: Pool;

	const stamp = Date.now();
	let userA: number;
	let userB: number;
	let communityId: number;
	/* @info - Second community used only by the deterministic concurrency test so
	 *          its row lock can't interact with the other assertions. */
	let raceCommunityId: number;
	const createdConversations = new Set<number>();

	beforeAll(async () => {
		await connectPostgresDB(() => {});
		db = getDb();
		pool = new Pool({ connectionString: config.db.uri, max: 2 });

		const makeUser = async (tag: string) => {
			const r = await db.execute(
				`INSERT INTO users (first_name, last_name, email, email_verified, onboarded)
				 VALUES ('Msg', 'Test', 'msg-dedupe-${tag}-${stamp}@test.local', true, true)
				 RETURNING id`,
			);
			return (r.rows[0] as { id: number }).id;
		};
		userA = await makeUser("a");
		userB = await makeUser("b");

		const comm = await db.execute(
			`INSERT INTO communities (owner_id, name, slug)
			 VALUES (${userA}, 'Msg Dedupe ${stamp}', 'msg-dedupe-${stamp}')
			 RETURNING id`,
		);
		communityId = (comm.rows[0] as { id: number }).id;

		await db.execute(
			`INSERT INTO community_members (community_id, user_id, role)
			 VALUES (${communityId}, ${userA}, 'student'), (${communityId}, ${userB}, 'student')`,
		);

		const raceComm = await db.execute(
			`INSERT INTO communities (owner_id, name, slug)
			 VALUES (${userA}, 'Msg Dedupe Race ${stamp}', 'msg-dedupe-race-${stamp}')
			 RETURNING id`,
		);
		raceCommunityId = (raceComm.rows[0] as { id: number }).id;
		await db.execute(
			`INSERT INTO community_members (community_id, user_id, role)
			 VALUES (${raceCommunityId}, ${userA}, 'student'), (${raceCommunityId}, ${userB}, 'student')`,
		);
	});

	afterAll(async () => {
		const ids = [...createdConversations].join(",");
		if (ids) await db.execute(`DELETE FROM conversations WHERE id IN (${ids})`);
		await db.execute(`DELETE FROM conversations WHERE community_id = ${communityId}`);
		await db.execute(`DELETE FROM conversations WHERE community_id = ${raceCommunityId}`);
		await db.execute(`DELETE FROM community_members WHERE community_id IN (${communityId}, ${raceCommunityId})`);
		await db.execute(`DELETE FROM communities WHERE id IN (${communityId}, ${raceCommunityId})`);
		await db.execute(`DELETE FROM users WHERE id IN (${userA}, ${userB})`);
		await pool.end();
	});

	it("creates ONE community chat when two list calls race", async () => {
		const results = await Promise.all([
			repo.ensureCommunityConversation(communityId, "Race A"),
			repo.ensureCommunityConversation(communityId, "Race B"),
		]);

		for (const c of results) if (c) createdConversations.add(c.id);
		expect(results.every((c) => c?.id)).toBe(true);
		expect(new Set(results.map((c) => c!.id)).size).toBe(1);

		const count = await db.execute(
			`SELECT count(*)::int AS n FROM conversations
			 WHERE community_id = ${communityId} AND type = 'group'`,
		);
		expect((count.rows[0] as { n: number }).n).toBe(1);

		/* Both active members are participants of that single chat */
		const parts = await db.execute(
			`SELECT user_id FROM conversation_participants
			 WHERE conversation_id = ${results[0]!.id} ORDER BY user_id`,
		);
		const participantIds = parts.rows.map((r) => (r as { user_id: number }).user_id);
		expect(participantIds.sort()).toEqual([userA, userB].sort());
	});

	it("survives a concurrent ensure that commits first", async () => {
		/* @info - Deterministic race: hold an uncommitted group row for this
		 *          community, so the ensure below reaches its INSERT while the
		 *          conflicting row is still invisible to its SELECT. With the
		 *          ON CONFLICT insert the call waits, finds the winner and returns
		 *          it; with the old SELECT-then-INSERT it raised a unique violation
		 *          (verified by mutating the fix back — this test caught it). */
		const blocker = await pool.connect();
		try {
			await blocker.query("BEGIN");
			await blocker.query(
				`INSERT INTO conversations (type, title, community_id)
				 VALUES ('group', 'Racing winner', ${raceCommunityId})`,
			);

			const pending = repo.ensureCommunityConversation(
				raceCommunityId,
				"Racing loser",
			);
			/* Let the ensure reach the conflicting insert before we commit. */
			await new Promise((r) => setTimeout(r, 300));
			await blocker.query("COMMIT");

			const resolved = await pending;
			expect(resolved).not.toBeNull();
			createdConversations.add(resolved!.id);

			const count = await db.execute(
				`SELECT count(*)::int AS n FROM conversations
				 WHERE community_id = ${raceCommunityId} AND type = 'group'`,
			);
			expect((count.rows[0] as { n: number }).n).toBe(1);
		} finally {
			blocker.release();
		}
	});

	it("resolves the existing chat instead of inserting a second row", async () => {
		const first = await repo.ensureCommunityConversation(communityId, "First");
		const second = await repo.ensureCommunityConversation(communityId, "Second");
		createdConversations.add(first!.id);
		expect(second!.id).toBe(first!.id);

		const count = await db.execute(
			`SELECT count(*)::int AS n FROM conversations
			 WHERE community_id = ${communityId} AND type = 'group'`,
		);
		expect((count.rows[0] as { n: number }).n).toBe(1);
	});

	it("database refuses a second group conversation for the same community", async () => {
		const client = await pool.connect();
		try {
			/* Raw client: the driver surfaces the PG error code, so this asserts a
			 * unique violation (23505) rather than "some insert failed". */
			await expect(
				client.query(
					`INSERT INTO conversations (type, title, community_id)
					 VALUES ('group', 'Forbidden duplicate', ${communityId})`,
				),
			).rejects.toMatchObject({ code: "23505" });
		} finally {
			client.release();
		}
	});

	it("has the partial unique index that makes the invariant hold", async () => {
		const r = await db.execute(
			`SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_conversations_community_group'`,
		);
		expect(r.rows).toHaveLength(1);
		const def = (r.rows[0] as { indexdef: string }).indexdef;
		expect(def).toMatch(/UNIQUE/);
		expect(def).toMatch(/WHERE/);
	});

	it("migration 0026 merges duplicates and keeps the messages", async () => {
		const sqlPath = join(
			process.cwd(),
			"src",
			"db",
			"migrations",
			"0026_dedupe_community_conversations.sql",
		);
		const statements = readFileSync(sqlPath, "utf-8")
			.split("--> statement-breakpoint")
			.map((s) => s.trim())
			.filter(Boolean);

		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			/* The index forbids exactly what we are about to seed, so drop it for
			 * the duration of this transaction (rolled back below). */
			await client.query("DROP INDEX IF EXISTS uq_conversations_community_group");

			const empty = await client.query(
				`INSERT INTO conversations (type, title, community_id) VALUES ('group', 'Empty dup', ${communityId}) RETURNING id`,
			);
			const withMessage = await client.query(
				`INSERT INTO conversations (type, title, community_id) VALUES ('group', 'Has messages', ${communityId}) RETURNING id`,
			);
			const emptyId = (empty.rows[0] as { id: number }).id;
			const survivorId = (withMessage.rows[0] as { id: number }).id;

			await client.query(
				`INSERT INTO conversation_participants (conversation_id, user_id, role)
				 VALUES (${survivorId}, ${userA}, 'student'), (${emptyId}, ${userB}, 'student')`,
			);
			await client.query(
				`INSERT INTO messages (conversation_id, sender_id, content)
				 VALUES (${survivorId}, ${userA}, 'survives the merge')`,
			);

			for (const stmt of statements) await client.query(stmt);

			const survivors = await client.query(
				`SELECT id FROM conversations WHERE community_id = ${communityId}`,
			);
			expect(survivors.rows).toHaveLength(1);
			/* Most messages wins, so the thread carrying the message survives. */
			expect((survivors.rows[0] as { id: number }).id).toBe(survivorId);

			const msgs = await client.query(
				`SELECT content FROM messages WHERE conversation_id = ${survivorId}`,
			);
			expect(msgs.rows.map((r) => (r as { content: string }).content)).toContain(
				"survives the merge",
			);

			/* Participants from both duplicates end up on the survivor */
			const parts = await client.query(
				`SELECT user_id FROM conversation_participants WHERE conversation_id = ${survivorId} ORDER BY user_id`,
			);
			expect(
				parts.rows.map((r) => (r as { user_id: number }).user_id),
			).toEqual([userA, userB]);
		} finally {
			await client.query("ROLLBACK");
			client.release();
		}
	});

	it("creates ONE direct thread when two creates race", async () => {
		const [first, second] = await Promise.all([
			repo.createDirect(userA, "student", userB, "student"),
			repo.createDirect(userB, "student", userA, "student"),
		]);

		expect(first?.id).toBe(second?.id);
		createdConversations.add(first!.id);

		const count = await db.execute(
			`SELECT count(*)::int AS n FROM conversations c
			 JOIN conversation_participants p1 ON p1.conversation_id = c.id AND p1.user_id = ${userA}
			 JOIN conversation_participants p2 ON p2.conversation_id = c.id AND p2.user_id = ${userB}
			 WHERE c.type = 'direct'`,
		);
		expect((count.rows[0] as { n: number }).n).toBe(1);
	});

	it("returns the existing direct thread on a second call", async () => {
		const existing = await repo.createDirect(userA, "student", userB, "student");
		const again = await repo.createDirect(userB, "student", userA, "student");
		expect(again?.id).toBe(existing?.id);

		const count = await db.execute(
			`SELECT count(*)::int AS n FROM conversations c
			 JOIN conversation_participants p1 ON p1.conversation_id = c.id AND p1.user_id = ${userA}
			 JOIN conversation_participants p2 ON p2.conversation_id = c.id AND p2.user_id = ${userB}
			 WHERE c.type = 'direct'`,
		);
		expect((count.rows[0] as { n: number }).n).toBe(1);
	});
});
