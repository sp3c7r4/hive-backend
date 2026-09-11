import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { JwtAction, UserTypes } from "@/enums";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { CalendarService } from "@/modules/calendar";
import { LiveService, LiveSessionService } from "@/modules/live";
import { testApp } from "./setup";

/**
 * @info - Standalone community events (phase 2). A live class with no course behind it:
 *
 *  - owner / admin of the community  -> create, edit, cancel, delete
 *  - the session's host              -> edit, cancel, delete their own
 *  - any other active member         -> may join and list, may NOT manage (403)
 *  - an outsider                     -> 404 everywhere (no existence leak)
 *  - active members (minus the host) -> get an in-app notification on creation
 *
 * Creates real rows in a throwaway community and cleans them up.
 */
describe("Live sessions phase 2 (standalone community events)", () => {
	const sessions = LiveSessionService.getInstance();
	const live = LiveService.getInstance();
	let db: ReturnType<typeof getDb>;

	const stamp = Date.now();

	let ownerUserId: number;
	let adminUserId: number;
	let memberUserId: number;
	let otherHostUserId: number;
	let outsiderUserId: number;
	let communityId: number;
	let otherCommunityId: number;
	let otherCommunitySessionId: number;
	let hostOwnedSessionId: number;
	let endedSessionId: number;
	let courseId: number;
	let lessonSessionId: number;
	let lessonId: number;

	const auth = (id: number): IAuthData => ({
		id,
		authId: String(id),
		action: JwtAction.AUTHENTICATE,
		userType: UserTypes.USER,
		firstName: "Live",
		lastName: "Phase Two",
	});

	/** @info - The notification is fire-and-forget by design, so poll briefly. */
	const notificationsFor = async (sessionId: number) => {
		for (let attempt = 0; attempt < 40; attempt++) {
			const rows = (
				await db.execute(
					`SELECT user_id, title, message, metadata FROM notifications
					 WHERE (metadata->>'sessionId')::int = ${sessionId} ORDER BY user_id`,
				)
			).rows as {
				user_id: number;
				title: string;
				message: string;
				metadata: Record<string, unknown>;
			}[];
			if (rows.length > 0) return rows;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		return [];
	};

	beforeAll(async () => {
		await connectPostgresDB(() => {});
		db = getDb();

		const makeUser = async (email: string) => {
			const r = await db.execute(
				`INSERT INTO users (first_name, last_name, email, email_verified, onboarded)
				 VALUES ('Live', 'Phase Two', '${email}', true, true) RETURNING id`,
			);
			return (r.rows[0] as { id: number }).id;
		};

		ownerUserId = await makeUser(`p2-owner-${stamp}@test.local`);
		adminUserId = await makeUser(`p2-admin-${stamp}@test.local`);
		memberUserId = await makeUser(`p2-member-${stamp}@test.local`);
		otherHostUserId = await makeUser(`p2-host-${stamp}@test.local`);
		outsiderUserId = await makeUser(`p2-outsider-${stamp}@test.local`);

		const makeCommunity = async (name: string, slug: string) => {
			const r = await db.execute(
				`INSERT INTO communities (owner_id, name, slug)
				 VALUES (${ownerUserId}, '${name}', '${slug}') RETURNING id`,
			);
			return (r.rows[0] as { id: number }).id;
		};
		communityId = await makeCommunity(
			"Phase Two Community",
			`p2-comm-${stamp}`,
		);
		otherCommunityId = await makeCommunity(
			"Phase Two Other Community",
			`p2-other-${stamp}`,
		);

		/* @info - Membership is what the access rules read, so state it explicitly:
		 * an owner, an admin and two plain members - none of them instructors. */
		await db.execute(
			`INSERT INTO community_members (community_id, user_id, role, member_role, status)
			 VALUES (${communityId}, ${ownerUserId}, 'student', 'owner', 'active'),
			        (${communityId}, ${adminUserId}, 'student', 'admin', 'active'),
			        (${communityId}, ${memberUserId}, 'student', 'member', 'active'),
			        (${communityId}, ${otherHostUserId}, 'student', 'member', 'active'),
			        (${otherCommunityId}, ${ownerUserId}, 'student', 'owner', 'active')`,
		);

		const makeStandalone = async (
			title: string,
			hostId: number,
			status: string,
			offset: string,
			community = communityId,
		) => {
			const r = await db.execute(
				`INSERT INTO live_sessions (kind, community_id, course_id, host_id, title, starts_at, duration_minutes, status)
				 VALUES ('native', ${community}, NULL, ${hostId}, '${title}', now() + interval '${offset}', 60, '${status}')
				 RETURNING id`,
			);
			return (r.rows[0] as { id: number }).id;
		};

		/* @info - A plain member hosts this one: proves "host" works without owner/admin. */
		hostOwnedSessionId = await makeStandalone(
			"Host Owned Session",
			otherHostUserId,
			"scheduled",
			"3 days",
		);
		endedSessionId = await makeStandalone(
			"Ended Session",
			ownerUserId,
			"ended",
			"-2 days",
		);
		otherCommunitySessionId = await makeStandalone(
			"Other Community Session",
			ownerUserId,
			"scheduled",
			"4 days",
			otherCommunityId,
		);

		/* @info - A course class, for the rule that its title/description belong to the
		 * lesson rather than to this endpoint. */
		const courseRows = await db.execute(
			`INSERT INTO courses (instructor_id, community_id, title, slug, status, category, price)
			 VALUES (${ownerUserId}, ${communityId}, 'Phase Two Course', 'p2-course-${stamp}', 'published', 'test', 0)
			 RETURNING id`,
		);
		courseId = (courseRows.rows[0] as { id: number }).id;
		const moduleRows = await db.execute(
			`INSERT INTO modules (course_id, title, sort_order)
			 VALUES (${courseId}, 'Phase Two Module', 999) RETURNING id`,
		);
		const moduleId = (moduleRows.rows[0] as { id: number }).id;
		lessonSessionId = await makeStandalone(
			"Course Class",
			ownerUserId,
			"scheduled",
			"2 days",
		);
		await db.execute(
			`UPDATE live_sessions SET course_id = ${courseId} WHERE id = ${lessonSessionId}`,
		);
		const lessonRows = await db.execute(
			`INSERT INTO lessons (module_id, title, type, status, sort_order, live_session_id)
			 VALUES (${moduleId}, 'Course Class', 'live', 'published', 0, ${lessonSessionId}) RETURNING id`,
		);
		lessonId = (lessonRows.rows[0] as { id: number }).id;
	});

	afterAll(async () => {
		await db.execute(
			`DELETE FROM notifications WHERE (metadata->>'communityId')::int IN (${communityId}, ${otherCommunityId})`,
		);
		await db.execute(`DELETE FROM lessons WHERE id = ${lessonId}`);
		await db.execute(`DELETE FROM modules WHERE course_id = ${courseId}`);
		await db.execute(`DELETE FROM courses WHERE id = ${courseId}`);
		await db.execute(
			`DELETE FROM live_sessions WHERE community_id IN (${communityId}, ${otherCommunityId})`,
		);
		await db.execute(
			`DELETE FROM community_members WHERE community_id IN (${communityId}, ${otherCommunityId})`,
		);
		await db.execute(
			`DELETE FROM communities WHERE id IN (${communityId}, ${otherCommunityId})`,
		);
		await db.execute(
			`DELETE FROM users WHERE id IN (${ownerUserId}, ${adminUserId}, ${memberUserId}, ${otherHostUserId}, ${outsiderUserId})`,
		);
	});

	const inDays = (days: number) =>
		new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

	it("lets a community owner schedule a class with no course behind it", async () => {
		const created = await sessions.createSession(
			auth(ownerUserId),
			communityId,
			{
				kind: "native",
				title: "Weekly Q&A",
				description: "Open questions",
				startsAt: inDays(2),
				durationMinutes: 45,
			},
		);

		expect(created.kind).toBe("native");
		expect(created.status).toBe("scheduled");
		expect(created.courseId).toBeNull();
		expect(created.hostId).toBe(ownerUserId);
		expect(created.communityId).toBe(communityId);
		expect(created.durationMinutes).toBe(45);
		expect(created.lesson).toBeNull();
		expect(created.communitySlug).toBe(`p2-comm-${stamp}`);
	});

	it("lets a community admin schedule one too", async () => {
		const created = await sessions.createSession(
			auth(adminUserId),
			communityId,
			{
				kind: "native",
				title: "Orientation",
				startsAt: inDays(5),
			},
		);
		expect(created.hostId).toBe(adminUserId);
		expect(created.status).toBe("scheduled");
	});

	it("refuses a plain member (403) and hides the community from an outsider (404)", async () => {
		await expect(
			sessions.createSession(auth(memberUserId), communityId, {
				kind: "native",
				title: "Not allowed",
				startsAt: inDays(1),
			}),
		).rejects.toThrow(/owners and admins/i);

		await expect(
			sessions.createSession(auth(outsiderUserId), communityId, {
				kind: "native",
				title: "Not allowed",
				startsAt: inDays(1),
			}),
		).rejects.toThrow(/community not found/i);
	});

	it("requires a link for an external session and rejects one on a Hive room", async () => {
		await expect(
			sessions.createSession(auth(ownerUserId), communityId, {
				kind: "external",
				title: "Needs a link",
				startsAt: inDays(1),
			}),
		).rejects.toThrow(/meeting link/i);

		await expect(
			sessions.createSession(auth(ownerUserId), communityId, {
				kind: "native",
				title: "Hive room with a link",
				meetingUrl: "https://meet.example/nope",
				startsAt: inDays(1),
			}),
		).rejects.toThrow(/hive room/i);
	});

	it("accepts an external session with a link", async () => {
		const created = await sessions.createSession(
			auth(ownerUserId),
			communityId,
			{
				kind: "external",
				title: "Office hours on Zoom",
				meetingUrl: "https://zoom.us/j/12345",
				startsAt: inDays(6),
			},
		);
		expect(created.kind).toBe("external");
		expect(created.meetingUrl).toBe("https://zoom.us/j/12345");
	});

	it("lists upcoming and past sessions for members, and only from that community", async () => {
		const upcoming = await sessions.listCommunitySessions(
			auth(memberUserId),
			communityId,
			"upcoming",
		);
		expect(upcoming.length).toBeGreaterThanOrEqual(3);
		expect(upcoming.every((s) => s.communityId === communityId)).toBe(true);
		expect(upcoming.every((s) => s.status === "scheduled")).toBe(true);
		expect(upcoming.some((s) => s.id === otherCommunitySessionId)).toBe(false);
		expect(upcoming.some((s) => s.id === endedSessionId)).toBe(false);

		/* @info - A course's live class in this community is NOT listed: access to it is
		 * enrollment, not membership, so showing it would advertise a class a plain member
		 * cannot join. It stays on the course page and the host's calendar. */
		expect(upcoming.some((s) => s.id === lessonSessionId)).toBe(false);
		const event = upcoming.find((s) => s.id === hostOwnedSessionId);
		expect(event?.courseId).toBeNull();
		expect(event?.lesson).toBeNull();

		/* ordered by when they start */
		const times = upcoming.map((s) => new Date(s.startsAt!).getTime());
		expect(times).toEqual([...times].sort((a, b) => a - b));

		const past = await sessions.listCommunitySessions(
			auth(memberUserId),
			communityId,
			"past",
		);
		expect(past.map((s) => s.id)).toContain(endedSessionId);
		expect(past.every((s) => ["ended", "cancelled"].includes(s.status))).toBe(
			true,
		);

		/* what a member sees they may act on only if they host it */
		const hosted = upcoming.find((s) => s.id === hostOwnedSessionId);
		expect(hosted?.isHost).toBe(false);
		expect(hosted?.canModerate).toBe(false);
	});

	it("hides the list from outsiders and rejects an unknown scope", async () => {
		await expect(
			sessions.listCommunitySessions(
				auth(outsiderUserId),
				communityId,
				"upcoming",
			),
		).rejects.toThrow(/community not found/i);

		await expect(
			sessions.listCommunitySessions(
				auth(memberUserId),
				communityId,
				"whenever" as never,
			),
		).rejects.toThrow(/scope/i);
	});

	it("lets the host manage their own session without being an owner or admin", async () => {
		const updated = await sessions.updateSession(
			auth(otherHostUserId),
			hostOwnedSessionId,
			{ title: "Host Owned Session (edited)", durationMinutes: 30 },
		);
		expect(updated.title).toBe("Host Owned Session (edited)");
		expect(updated.durationMinutes).toBe(30);
	});

	it("lets an owner or admin manage someone else's session, and refuses a plain member", async () => {
		const updated = await sessions.updateSession(
			auth(adminUserId),
			hostOwnedSessionId,
			{
				title: "Renamed by an admin",
			},
		);
		expect(updated.title).toBe("Renamed by an admin");

		await expect(
			sessions.updateSession(auth(memberUserId), hostOwnedSessionId, {
				title: "Member edit",
			}),
		).rejects.toThrow(/only the host/i);
	});

	it("refuses to change a session's kind, with the phase 1 copy", async () => {
		await expect(
			sessions.updateSession(auth(ownerUserId), hostOwnedSessionId, {
				kind: "external",
			} as never),
		).rejects.toThrow(/cannot be changed.*set the type to none/i);

		const row = await sessions.loadById(hostOwnedSessionId);
		expect(row.kind).toBe("native");
	});

	it("re-arms an ended session when it is rescheduled", async () => {
		const updated = await sessions.updateSession(
			auth(ownerUserId),
			endedSessionId,
			{
				startsAt: inDays(3),
			},
		);
		expect(updated.status).toBe("scheduled");
	});

	it("keeps a link on an external session instead of letting it be cleared", async () => {
		const external = await sessions.createSession(
			auth(ownerUserId),
			communityId,
			{
				kind: "external",
				title: "Link must survive",
				meetingUrl: "https://meet.example/keep",
				startsAt: inDays(7),
			},
		);

		await expect(
			sessions.updateSession(auth(ownerUserId), external.id, {
				meetingUrl: null,
			}),
		).rejects.toThrow(/meeting link/i);

		const renamed = await sessions.updateSession(
			auth(ownerUserId),
			external.id,
			{
				title: "Still has a link",
				meetingUrl: "https://meet.example/kept",
			},
		);
		expect(renamed.meetingUrl).toBe("https://meet.example/kept");
	});

	it("cancels idempotently and stops members joining", async () => {
		const created = await sessions.createSession(
			auth(ownerUserId),
			communityId,
			{
				kind: "native",
				title: "To be cancelled",
				startsAt: inDays(4),
			},
		);

		const first = await sessions.cancelSession(auth(ownerUserId), created.id);
		const second = await sessions.cancelSession(auth(ownerUserId), created.id);
		expect(first.status).toBe("cancelled");
		expect(second.status).toBe("cancelled");

		/* the records stay visible to members as cancelled */
		const past = await sessions.listCommunitySessions(
			auth(memberUserId),
			communityId,
			"past",
		);
		expect(past.map((s) => s.id)).toContain(created.id);

		await expect(
			live.issueToken(auth(memberUserId), created.id),
		).rejects.toThrow(/has ended/i);

		/* a plain member cannot cancel someone else's session */
		await expect(
			sessions.cancelSession(auth(memberUserId), created.id),
		).rejects.toThrow(/only the host/i);
	});

	it("soft-deletes a session so it disappears everywhere", async () => {
		const created = await sessions.createSession(
			auth(ownerUserId),
			communityId,
			{
				kind: "native",
				title: "To be deleted",
				startsAt: inDays(8),
			},
		);

		await expect(
			sessions.deleteSession(auth(memberUserId), created.id),
		).rejects.toThrow(/only the host/i);

		await sessions.deleteSession(auth(ownerUserId), created.id);

		await expect(
			live.getSession(auth(ownerUserId), created.id),
		).rejects.toThrow(/session not found/i);

		const upcoming = await sessions.listCommunitySessions(
			auth(memberUserId),
			communityId,
			"upcoming",
		);
		expect(upcoming.some((s) => s.id === created.id)).toBe(false);

		const [row] = (
			await db.execute(
				`SELECT deleted_at FROM live_sessions WHERE id = ${created.id}`,
			)
		).rows as { deleted_at: Date | null }[];
		expect(row!.deleted_at).not.toBeNull();
	});

	it("notifies active members on creation, never the host or an outsider", async () => {
		const created = await sessions.createSession(
			auth(ownerUserId),
			communityId,
			{
				kind: "native",
				title: "Notified Session",
				startsAt: inDays(9),
			},
		);

		const rows = await notificationsFor(created.id);
		const recipients = rows.map((r) => Number(r.user_id)).sort((a, b) => a - b);

		/* admin, plain member, other host - everyone active except the creator */
		expect(recipients).toEqual(
			[adminUserId, memberUserId, otherHostUserId].sort((a, b) => a - b),
		);
		expect(recipients).not.toContain(ownerUserId);
		expect(recipients).not.toContain(outsiderUserId);
		expect(rows[0]!.title).toMatch(/live class/i);
		expect(Number(rows[0]!.metadata.communityId)).toBe(communityId);
	});

	it("puts a newly scheduled class on the host's calendar", async () => {
		/* @info - Acceptance 1: scheduling from the host side has to surface in their
		 * calendar, which reads sessions for both kinds (course classes and events). */
		const anchor = new Date(
			Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 20, 12),
		);
		const month = anchor.toISOString().slice(0, 7);
		const created = await sessions.createSession(
			auth(adminUserId),
			communityId,
			{
				kind: "native",
				title: "Calendar Visible Class",
				startsAt: anchor.toISOString(),
			},
		);

		const events = await CalendarService.getInstance().listEvents(
			auth(adminUserId),
			month,
		);
		const event = events.find((e) => e.data.sessionId === created.id);
		expect(event).toBeDefined();
		expect(event!.data.meetingType).toBe("native");
		expect(event!.title).toBe("Calendar Visible Class");
	});

	it("keeps a lesson session's title and description with the lesson", async () => {
		/* @info - The lesson saver re-syncs those two from the lesson, so accepting them
		 * here would be silently overwritten; time and duration stay editable. */
		await expect(
			sessions.updateSession(auth(ownerUserId), lessonSessionId, {
				title: "Renamed from the calendar",
			}),
		).rejects.toThrow(/edit its title or description from the course/i);

		const moved = await sessions.updateSession(
			auth(ownerUserId),
			lessonSessionId,
			{ startsAt: inDays(12), durationMinutes: 90 },
		);
		expect(moved.durationMinutes).toBe(90);
		expect(moved.lesson?.id).toBe(lessonId);
	});

	it("mounts the standalone-event routes (401, not 404, without a token)", async () => {
		/* @info - The suite above calls the service, so a path typo in the router would
		 * otherwise ship unnoticed: an unmounted route answers 404, a mounted one 401. */
		const routes: [string, string][] = [
			["POST", `/api/v1/live/communities/${communityId}/sessions`],
			[
				"GET",
				`/api/v1/live/communities/${communityId}/sessions?scope=upcoming`,
			],
			["PATCH", `/api/v1/live/sessions/${endedSessionId}`],
			["POST", `/api/v1/live/sessions/${endedSessionId}/cancel`],
			["DELETE", `/api/v1/live/sessions/${endedSessionId}`],
		];

		for (const [method, path] of routes) {
			const body =
				method === "GET" || method === "DELETE"
					? {}
					: {
							body: "{}",
							headers: { "Content-Type": "application/json" },
						};
			const res = await testApp.request(path, { method, ...body });
			expect(res.status, `${method} ${path}`).toBe(401);
		}
	});
});
