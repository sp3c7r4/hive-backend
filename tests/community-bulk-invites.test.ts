import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { BULK_INVITE_DAILY_LIMIT } from "@/modules/communities/community-member.service";
import { CacheService } from "@/services/cache.service";
import { JwtService } from "@/services/jwt.service";
import { EmailQueueService } from "@/services/queues/email.queue.service";

/**
 * @info - Bulk invites: many invitations in one request, answered per address.
 *
 * The value of the feature is that one typo in a pasted list of two hundred does not lose
 * the other one hundred and ninety nine, so the endpoint never fails a batch as a whole. The
 * two things worth locking down are therefore the outcome of each address and the number of
 * rows and queued emails that come out of it, plus the daily allowance that stops the
 * endpoint being a way to send unlimited mail from someone else's domain.
 *
 * Requires local Postgres + Redis, like every DB-backed test here.
 */

const OWNER_AUTH = "auth:bulk-invite-owner";
const MEMBER_AUTH = "auth:bulk-invite-member";
const OTHER_AUTH = "auth:bulk-invite-other";

const OWNER_EMAIL = "bulk.invite.owner@hive.test";
const MEMBER_EMAIL = "bulk.invite.member@hive.test";
const OTHER_EMAIL = "bulk.invite.other@hive.test";
const PENDING_EMAIL = "bulk.invite.pending@hive.test";
const NEW_ONE = "bulk.invite.one@example.com";
const NEW_TWO = "bulk.invite.two@example.com";

const SLUG = "bulk-invite-community";

let db: ReturnType<typeof getDb>;
let app: Hono;
const tokens: Record<string, string> = {};
let communityId: number;

const sql = async (statement: string) => {
	const result = await db.execute(statement);
	return result.rows as any[];
};
const one = async (statement: string) => (await sql(statement))[0];

const cleanup = async () => {
	await sql(
		`DELETE FROM community_invites WHERE community_id IN (SELECT id FROM communities WHERE slug = '${SLUG}')`,
	);
	await sql(
		`DELETE FROM community_members WHERE community_id IN (SELECT id FROM communities WHERE slug = '${SLUG}')`,
	);
	await sql(`DELETE FROM communities WHERE slug = '${SLUG}'`);
	await sql(
		`DELETE FROM users WHERE lower(email) IN ('${OWNER_EMAIL}', '${MEMBER_EMAIL}', '${OTHER_EMAIL}')`,
	);
};

const bulk = (emails: string[], authId: string, slug = SLUG) =>
	app.request(`/api/v1/communities/${slug}/invites/bulk`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${tokens[authId] as string}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ emails }),
	});

/* @info - Read once: a Response body cannot be read twice, and reading it twice is a
 * test bug that looks like a server bug. */
const bodyOf = async (res: Response) => (await res.json()) as any;

const pendingRows = async () =>
	(
		await one(
			`SELECT count(*)::int AS n FROM community_invites WHERE community_id = ${communityId} AND status = 'pending'`,
		)
	)?.n as number;

/* @info - Jobs sit in Redis until a worker takes them, so the suite measures the delta it
 * caused rather than the queue's absolute size, which other suites share. */
const queueSize = async () => {
	const counts = await EmailQueueService.getInstance()
		.getQueue()
		.getJobCounts("waiting", "delayed", "active");
	return (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.active ?? 0);
};

const lagosDay = () =>
	new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());

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
			await sql(`INSERT INTO user_roles (user_id, role) VALUES (${id}, '${role}')`);
		}
		return id;
	};
	const signIn = async (authId: string, id: number, email: string, roles: string[]) => {
		tokens[authId] = jwt.generateToken(authId);
		await cache.set(authId, {
			id,
			email,
			firstName: "Bulk",
			roles,
			isAuthenticated: true,
		});
	};

	const ownerId = await mkUser("Own", OWNER_EMAIL, ["instructor"]);
	const memberId = await mkUser("Mem", MEMBER_EMAIL, ["student"]);
	const otherId = await mkUser("Oth", OTHER_EMAIL, ["instructor"]);

	await signIn(OWNER_AUTH, ownerId, OWNER_EMAIL, ["instructor"]);
	await signIn(MEMBER_AUTH, memberId, MEMBER_EMAIL, ["student"]);
	await signIn(OTHER_AUTH, otherId, OTHER_EMAIL, ["instructor"]);

	communityId = (
		await one(
			`INSERT INTO communities (name, slug, owner_id) VALUES ('Bulk Invite Community', '${SLUG}', ${ownerId}) RETURNING id`,
		)
	).id as number;

	/* @info - The creator is a member with memberRole owner, because that is what
	 * `CommunityService.create` writes in real life and what the admin guard reads. */
	await sql(
		`INSERT INTO community_members (community_id, user_id, role, member_role, status) VALUES (${communityId}, ${ownerId}, 'instructor', 'owner', 'active')`,
	);
	await sql(
		`INSERT INTO community_members (community_id, user_id, role, member_role, status) VALUES (${communityId}, ${memberId}, 'student', 'member', 'active')`,
	);
	/* One invitation already waiting, so "already invited" is a real answer, not a guess. */
	await sql(
		`INSERT INTO community_invites (community_id, invited_by, email, status) VALUES (${communityId}, ${ownerId}, '${PENDING_EMAIL}', 'pending')`,
	);
});

afterAll(async () => {
	await cleanup();
});

describe("a pasted list", () => {
	it("answers every address and writes only the invitations that are new", async () => {
		const jobsBefore = await queueSize();
		const rowsBefore = await pendingRows();

		const res = await bulk(
			[
				NEW_ONE,
				"  " + NEW_TWO.toUpperCase() + "  ",
				OWNER_EMAIL,
				PENDING_EMAIL,
				"not-an-email",
				NEW_ONE,
			],
			OWNER_AUTH,
		);

		expect(res.status).toBe(200);
		const body = (await bodyOf(res)).data.data;
		expect(body.invited).toBe(2);
		expect(body.results).toEqual([
			{ email: NEW_ONE, outcome: "invited" },
			{ email: NEW_TWO, outcome: "invited" },
			{ email: OWNER_EMAIL, outcome: "already_member" },
			{ email: PENDING_EMAIL, outcome: "already_invited" },
			{ email: "not-an-email", outcome: "invalid" },
		]);

		expect(await pendingRows()).toBe(rowsBefore + 2);
		expect((await queueSize()) - jobsBefore).toBe(2);
	});

	it("reports the same list as already invited the second time, writing nothing", async () => {
		const jobsBefore = await queueSize();
		const rowsBefore = await pendingRows();

		const res = await bulk([NEW_ONE, NEW_TWO], OWNER_AUTH);

		expect(res.status).toBe(200);
		const body = (await bodyOf(res)).data.data;
		expect(body.invited).toBe(0);
		expect(
			(body.results as { email: string; outcome: string }[]).map((r) => r.outcome),
		).toEqual([
			"already_invited",
			"already_invited",
		]);
		expect(await pendingRows()).toBe(rowsBefore);
		expect(await queueSize()).toBe(jobsBefore);
	});
});

describe("who may send them", () => {
	it("refuses a student member and a stranger instructor, and writes nothing", async () => {
		const rowsBefore = await pendingRows();
		const jobsBefore = await queueSize();

		for (const authId of [MEMBER_AUTH, OTHER_AUTH]) {
			const res = await bulk(["someone.else@example.com"], authId);
			expect(res.status).toBe(403);
		}

		expect(await pendingRows()).toBe(rowsBefore);
		expect(await queueSize()).toBe(jobsBefore);
	});

	it("answers 404 for a community that does not exist, and 400 for a list it cannot use", async () => {
		const missing = await bulk([NEW_ONE], OWNER_AUTH, "no-such-community-here");
		expect(missing.status).toBe(404);

		expect((await bulk([], OWNER_AUTH)).status).toBe(400);

		const tooMany = await bulk(
			Array.from({ length: BULK_INVITE_DAILY_LIMIT + 1 }, (_, i) => `a${i}@example.com`),
			OWNER_AUTH,
		);
		expect(tooMany.status).toBe(400);
	});
});

describe("the daily allowance", () => {
	it("refuses with 429 once the community's day is spent, and writes nothing", async () => {
		const cache = CacheService.getInstance();
		const key = `community:bulk-invites:${communityId}:${lagosDay()}`;
		await cache.set(key, BULK_INVITE_DAILY_LIMIT - 1, 60);

		const rowsBefore = await pendingRows();
		const jobsBefore = await queueSize();

		const res = await bulk(["two.short@example.com", "one.short@example.com"], OWNER_AUTH);
		expect(res.status).toBe(429);
		expect(JSON.stringify(await res.json())).toMatch(/daily limit/i);

		expect(await pendingRows()).toBe(rowsBefore);
		expect(await queueSize()).toBe(jobsBefore);
	});

	it("resets when the day's key expires, which is what the TTL does", async () => {
		const cache = CacheService.getInstance();
		const res = await bulk(["fresh.day@example.com"], OWNER_AUTH);
		expect(res.status).toBe(429);

		await cache.delete(`community:bulk-invites:${communityId}:${lagosDay()}`);
		const next = await bulk(["fresh.day@example.com"], OWNER_AUTH);
		expect(next.status).toBe(200);
		expect(((await bodyOf(next)).data.data as any).invited).toBe(1);
	});
});
