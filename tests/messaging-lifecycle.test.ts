import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { config } from "@/config";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { CommunityMemberService } from "@/modules/communities/community-member.service";
import { CommunityService } from "@/modules/communities/community.service";
import { toConversationDto } from "@/modules/messaging/messaging.dto";
import { listConversationsQuerySchema } from "@/modules/messaging/messaging.schema";
import { MessagingRepository } from "@/modules/messaging/messaging.repository";
import { MessagingService } from "@/modules/messaging/messaging.service";

/**
 * @info - Messages × Communities lifecycle: a community chat is hidden per user
 * (left_at) rather than destroyed, the Communities tab gets it back, membership
 * is the source of truth for access, and a community's chat tracks its
 * community's name and lifetime. Expects a migrated database (npm run migrate).
 */
describe("Messaging × community chat lifecycle", () => {
	const repo = MessagingRepository.getInstance();
	const service = MessagingService.getInstance();
	const communityService = CommunityService.getInstance();
	const memberService = CommunityMemberService.getInstance();

	let db: ReturnType<typeof getDb>;
	let pool: Pool;

	const stamp = Date.now();
	let owner: number;
	let member: number;
	let outsider: number;

	/* Community A — list/hide/unhide/rename/delete */
	let communityA: number;
	const slugA = `msg-lifecycle-a-${stamp}`;
	let conversationA: number;

	/* Community B — removal/rejoin on the same participant row */
	let communityB: number;
	const slugB = `msg-lifecycle-b-${stamp}`;
	let conversationB: number;
	/* DM created by the fallback-shape test */
	let dmId: number | null = null;

	const authOf = (id: number, email: string) =>
		({
			id,
			email,
			firstName: "Msg",
			lastName: "Lifecycle",
			roles: [],
		}) as any;

	const ownerAuth = () => authOf(owner, `msg-lifecycle-owner-${stamp}@test.local`);
	const memberAuth = () => authOf(member, `msg-lifecycle-member-${stamp}@test.local`);

	beforeAll(async () => {
		await connectPostgresDB(() => {});
		db = getDb();
		pool = new Pool({ connectionString: config.db.uri, max: 2 });

		const makeUser = async (tag: string) => {
			const r = await db.execute(
				`INSERT INTO users (first_name, last_name, email, email_verified, onboarded)
				 VALUES ('Msg', 'Lifecycle', 'msg-lifecycle-${tag}-${stamp}@test.local', true, true)
				 RETURNING id`,
			);
			return (r.rows[0] as { id: number }).id;
		};
		owner = await makeUser("owner");
		member = await makeUser("member");
		outsider = await makeUser("outsider");

		const makeCommunity = async (slug: string, name: string) => {
			const r = await db.execute(
				`INSERT INTO communities (owner_id, name, slug, requires_approval)
				 VALUES (${owner}, '${name}', '${slug}', false)
				 RETURNING id`,
			);
			return (r.rows[0] as { id: number }).id;
		};

		communityA = await makeCommunity(slugA, `Msg Lifecycle A ${stamp}`);
		communityB = await makeCommunity(slugB, `Msg Lifecycle B ${stamp}`);

		await db.execute(
			`INSERT INTO community_members (community_id, user_id, role, member_role, status)
			 VALUES (${communityA}, ${owner}, 'student', 'owner', 'active'),
			        (${communityA}, ${member}, 'student', 'member', 'active'),
			        (${communityB}, ${owner}, 'student', 'owner', 'active'),
			        (${communityB}, ${member}, 'student', 'member', 'active')`,
		);

		/* The app provisions the chat on join/list; do the same here. */
		const a = await repo.ensureCommunityConversation(
			communityA,
			`Msg Lifecycle A ${stamp}`,
		);
		const b = await repo.ensureCommunityConversation(
			communityB,
			`Msg Lifecycle B ${stamp}`,
		);
		conversationA = a!.id;
		conversationB = b!.id;

		/* Unread material for the member (someone else's message). */
		await repo.insertMessage({
			conversationId: conversationA,
			senderId: owner,
			type: "text",
			content: "standup moved to 9am",
		});
		await repo.insertMessage({
			conversationId: conversationB,
			senderId: owner,
			type: "text",
			content: "history worth keeping",
		});
	});

	afterAll(async () => {
		if (dmId) await db.execute(`DELETE FROM conversations WHERE id = ${dmId}`);
		await db.execute(
			`DELETE FROM conversations WHERE community_id IN (${communityA}, ${communityB})`,
		);
		await db.execute(
			`DELETE FROM community_members WHERE community_id IN (${communityA}, ${communityB})`,
		);
		await db.execute(
			`DELETE FROM communities WHERE id IN (${communityA}, ${communityB})`,
		);
		await db.execute(`DELETE FROM users WHERE id IN (${owner}, ${member}, ${outsider})`);
		await pool.end();
	});

	it("keeps a hidden chat out of the default list and returns it flagged when asked", async () => {
		await repo.leaveConversation(conversationA, member);

		const visible = await repo.listForUser(member);
		expect(visible.find((r) => r.id === conversationA)).toBeUndefined();

		/* includeHidden=false (and ?includeHidden=0) stays hidden. */
		const explicitlyOff = await repo.listForUser(member, undefined, {
			includeHidden: false,
		});
		expect(explicitlyOff.find((r) => r.id === conversationA)).toBeUndefined();

		const withHidden = await repo.listForUser(member, undefined, {
			includeHidden: true,
		});
		const row = withHidden.find((r) => r.id === conversationA);
		expect(row).toBeTruthy();
		expect(row!.myLeftAt).not.toBeNull();

		/* Wire shape the FE draws the dot from: flagged hidden, unread intact. */
		const dto = toConversationDto(row!, { includeHidden: true });
		expect(dto.hidden).toBe(true);
		expect(dto.unreadCount).toBe(1);

		/* A visible chat is never flagged. */
		const shownRow = (await repo.listForUser(owner)).find(
			(r) => r.id === conversationA,
		);
		expect(toConversationDto(shownRow!, { includeHidden: true }).hidden).toBe(
			false,
		);
	});

	it("keeps the default payload free of the flag, and treats 0/false as off", () => {
		/* Every consumer but the Communities tab reads the legacy shape. */
		const visibleRow = {
			id: 1,
			type: "group",
			myLeftAt: null,
			unreadCount: 0,
			lastMessage: null,
		} as any;
		expect("hidden" in toConversationDto(visibleRow)).toBe(false);
		expect(
			"hidden" in toConversationDto({ ...visibleRow, myLeftAt: new Date() }),
		).toBe(false);
		expect(
			toConversationDto({ ...visibleRow, myLeftAt: new Date() }, {
				includeHidden: true,
			}).hidden,
		).toBe(true);

		expect(listConversationsQuerySchema.parse({}).includeHidden).toBe(false);
		expect(
			listConversationsQuerySchema.parse({ includeHidden: "0" }).includeHidden,
		).toBe(false);
		expect(
			listConversationsQuerySchema.parse({ includeHidden: "false" })
				.includeHidden,
		).toBe(false);
		expect(
			listConversationsQuerySchema.parse({ includeHidden: "1" }).includeHidden,
		).toBe(true);
		expect(
			listConversationsQuerySchema.parse({ includeHidden: "true" })
				.includeHidden,
		).toBe(true);
	});

	it("restores a hidden chat on unhide without touching its backlog", async () => {
		const dto = await service.unhideConversation(memberAuth(), conversationA);
		expect(dto.id).toBe(conversationA);
		expect((dto as any).hidden).toBe(false);

		const visible = await repo.listForUser(member);
		const row = visible.find((r) => r.id === conversationA);
		expect(row).toBeTruthy();
		/* Unread survived the round trip — restoring a chat is not reading it. */
		expect(row!.unreadCount).toBe(1);
		const participant = await repo.getParticipant(conversationA, member);
		expect(participant!.leftAt).toBeNull();
		expect(participant!.lastReadAt).toBeNull();
	});

	it("unhide is idempotent", async () => {
		await service.unhideConversation(memberAuth(), conversationA);
		const again = await service.unhideConversation(memberAuth(), conversationA);
		expect(again.id).toBe(conversationA);
		expect(await repo.isParticipant(conversationA, member)).toBe(true);
	});

	it("unhide refuses a caller who was never in the conversation", async () => {
		await expect(
			service.unhideConversation(authOf(outsider, `outsider-${stamp}@test.local`), conversationA),
		).rejects.toThrow(/not found/i);
	});

	it("propagates a community rename to its chat title", async () => {
		const renamed = `Msg Lifecycle A renamed ${stamp}`;
		await communityService.update(communityA, { name: renamed } as any, ownerAuth());
		const conversation = await repo.findCommunityConversation(communityA);
		expect(conversation!.title).toBe(renamed);
	});

	it("syncs a drifted chat title through the ensure path", async () => {
		/* Callers pass the community's CURRENT name (list/send read it fresh), so a
		 * chat whose stored title drifted must be pulled back in line. */
		const [communityRow] = (
			await db.execute(`SELECT name FROM communities WHERE id = ${communityA}`)
		).rows as { name: string }[];
		await db.execute(
			`UPDATE conversations SET title = 'Stale name' WHERE id = ${conversationA}`,
		);

		await repo.ensureCommunityConversation(communityA, communityRow!.name);

		const conversation = await repo.findCommunityConversation(communityA);
		expect(conversation!.title).toBe(communityRow!.name);
		expect(conversation!.title).not.toBe("Stale name");
	});

	it("never lets a stale caller snapshot overwrite the community's current name", async () => {
		await db.execute(
			`UPDATE conversations SET title = 'Drifted' WHERE id = ${conversationB}`,
		);
		const [communityRow] = (
			await db.execute(`SELECT name FROM communities WHERE id = ${communityB}`)
		).rows as { name: string }[];

		/* A list request that started BEFORE a rename hands in the old name. */
		await repo.ensureCommunityConversation(
			communityB,
			"Msg Lifecycle B (name from a stale snapshot)",
		);

		const conversation = await repo.findCommunityConversation(communityB);
		expect(conversation!.title).toBe(communityRow!.name);
	});

	it("hides the chat when a member is removed and reactivates the SAME row on rejoin", async () => {
		const before = (await repo.getParticipant(conversationB, member))!;
		await repo.insertMessage({
			conversationId: conversationB,
			senderId: owner,
			type: "text",
			content: "second message for context",
		});

		await memberService.removeMember(ownerAuth(), slugB, member);

		const hidden = await repo.getParticipant(conversationB, member);
		expect(hidden!.id).toBe(before.id);
		expect(hidden!.leftAt).not.toBeNull();
		expect(await repo.isParticipant(conversationB, member)).toBe(false);

		await memberService.joinCommunity(memberAuth(), slugB);

		const restored = await repo.getParticipant(conversationB, member);
		expect(restored!.id).toBe(before.id);
		expect(restored!.leftAt).toBeNull();
		expect(await repo.isParticipant(conversationB, member)).toBe(true);

		/* History intact: the chat was hidden, never rebuilt. */
		const rows = await db.execute(
			`SELECT count(*)::int AS n FROM messages WHERE conversation_id = ${conversationB}`,
		);
		expect((rows.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(2);
	});

	it("refuses unhide for a removed member: rejoining is what restores access", async () => {
		await memberService.removeMember(ownerAuth(), slugB, member);
		const hidden = (await repo.getParticipant(conversationB, member))!;
		expect(hidden.leftAt).not.toBeNull();

		await expect(
			service.unhideConversation(memberAuth(), conversationB),
		).rejects.toThrow(/member of this community/i);

		/* The back door stayed shut. */
		const stillHidden = (await repo.getParticipant(conversationB, member))!;
		expect(stillHidden.leftAt).not.toBeNull();
		expect(await repo.isParticipant(conversationB, member)).toBe(false);

		/* Rejoining reactivates the same row, and unhide is then a no-op. */
		await memberService.joinCommunity(memberAuth(), slugB);
		const restored = await service.unhideConversation(memberAuth(), conversationB);
		expect(restored.id).toBe(conversationB);
		expect((await repo.getParticipant(conversationB, member))!.id).toBe(
			hidden.id,
		);
	});

	it("hides the chat when a member leaves the community", async () => {
		await memberService.leaveCommunity(memberAuth(), slugB);
		const participant = await repo.getParticipant(conversationB, member);
		expect(participant!.leftAt).not.toBeNull();
		expect(await repo.isParticipant(conversationB, member)).toBe(false);

		/* Leaving is not a permanent cut either. */
		await memberService.joinCommunity(memberAuth(), slugB);
		expect(await repo.isParticipant(conversationB, member)).toBe(true);
	});

	it("returns a list-shaped DTO when the list can't resolve the conversation", async () => {
		const dm = await service.createConversation(ownerAuth(), member);
		dmId = dm.id;
		/* The peer deletes the DM: their left_at hides it from BOTH lists, so the
		 * unhide response has to fall back — with the real identity, not a guess. */
		await repo.leaveConversation(dmId, member);

		const dto = await service.unhideConversation(ownerAuth(), dmId);
		expect(dto.id).toBe(dmId);
		expect(dto.type).toBe("direct");
		expect(dto.communityId).toBeNull();
		expect((dto as any).hidden).toBe(false);

		const listRow = toConversationDto(
			(await repo.listForUser(owner)).find((r) => r.id === conversationB)!,
			{ includeHidden: true },
		);
		expect(Object.keys(dto).sort()).toEqual(Object.keys(listRow).sort());
	});

	it("writes the chat hide through the passed transaction, so a failure rolls back", async () => {
		const before = (await repo.getParticipant(conversationB, member))!;
		expect(before.leftAt).toBeNull();

		await expect(
			db.transaction(async (tx) => {
				await repo.setCommunityChatHidden(communityB, member, true, tx);
				throw new Error("rollback probe");
			}),
		).rejects.toThrow("rollback probe");

		/* Rolled back with the membership half it belongs to. */
		expect((await repo.getParticipant(conversationB, member))!.leftAt).toBeNull();

		/* Without a handle it still hides and restores (the membership paths). */
		await repo.setCommunityChatHidden(communityB, member, true);
		expect((await repo.getParticipant(conversationB, member))!.leftAt).not.toBeNull();
		await repo.setCommunityChatHidden(communityB, member, false);
		expect((await repo.getParticipant(conversationB, member))!.leftAt).toBeNull();
	});

	it("rolls a rejoin back with its chat restore when either half fails", async () => {
		/* Normalise: the member is out of community B, with the chat hidden. */
		const existing = await db.execute(
			`SELECT id FROM community_members WHERE community_id = ${communityB} AND user_id = ${member}`,
		);
		if (existing.rows.length) {
			await memberService.removeMember(ownerAuth(), slugB, member);
		}
		expect((await repo.getParticipant(conversationB, member))!.leftAt).not.toBeNull();

		/* The chat half fails after the membership half already ran. */
		const spy = vi
			.spyOn(repo, "setCommunityChatHidden")
			.mockRejectedValueOnce(new Error("chat restore probe"));
		await expect(
			memberService.joinCommunity(memberAuth(), slugB),
		).rejects.toThrow("chat restore probe");
		spy.mockRestore();

		/* The membership rolled back with it — no member left without their chat. */
		const afterFailure = await db.execute(
			`SELECT id FROM community_members WHERE community_id = ${communityB} AND user_id = ${member}`,
		);
		expect(afterFailure.rows.length).toBe(0);
		/* ... and the chat stayed hidden, so nothing granted access either. */
		expect((await repo.getParticipant(conversationB, member))!.leftAt).not.toBeNull();

		/* Both halves land together on the happy path. */
		await memberService.joinCommunity(memberAuth(), slugB);
		const joined = await db.execute(
			`SELECT status FROM community_members WHERE community_id = ${communityB} AND user_id = ${member}`,
		);
		expect(joined.rows.length).toBe(1);
		expect((await repo.getParticipant(conversationB, member))!.leftAt).toBeNull();
	});

	it("rolls an approval back with its chat restore when either half fails", async () => {
		/* Normalise: no membership, chat hidden, then a fresh pending application. */
		const existing = await db.execute(
			`SELECT id FROM community_members WHERE community_id = ${communityB} AND user_id = ${member}`,
		);
		if (existing.rows.length) {
			await memberService.removeMember(ownerAuth(), slugB, member);
		}
		await db.execute(
			`INSERT INTO community_members (community_id, user_id, role, member_role, status)
			 VALUES (${communityB}, ${member}, 'student', 'member', 'pending')`,
		);
		expect((await repo.getParticipant(conversationB, member))!.leftAt).not.toBeNull();

		const spy = vi
			.spyOn(repo, "setCommunityChatHidden")
			.mockRejectedValueOnce(new Error("chat restore probe"));
		await expect(
			memberService.approveMember(ownerAuth(), slugB, member),
		).rejects.toThrow("chat restore probe");
		spy.mockRestore();

		/* Still pending: the approval did not land without its chat half. */
		const afterFailure = await db.execute(
			`SELECT status FROM community_members WHERE community_id = ${communityB} AND user_id = ${member}`,
		);
		expect((afterFailure.rows[0] as { status: string }).status).toBe("pending");
		expect((await repo.getParticipant(conversationB, member))!.leftAt).not.toBeNull();

		/* Both halves land together on the happy path. */
		await memberService.approveMember(ownerAuth(), slugB, member);
		const approved = await db.execute(
			`SELECT status FROM community_members WHERE community_id = ${communityB} AND user_id = ${member}`,
		);
		expect((approved.rows[0] as { status: string }).status).toBe("active");
		expect((await repo.getParticipant(conversationB, member))!.leftAt).toBeNull();
	});

	it("deleting a community permanently takes its chat and messages with it", async () => {
		await communityService.delete(communityA, true, ownerAuth());

		expect(await repo.findCommunityConversation(communityA)).toBeUndefined();
		const msgs = await db.execute(
			`SELECT count(*)::int AS n FROM messages WHERE conversation_id = ${conversationA}`,
		);
		expect((msgs.rows[0] as { n: number }).n).toBe(0);
		const parts = await db.execute(
			`SELECT count(*)::int AS n FROM conversation_participants WHERE conversation_id = ${conversationA}`,
		);
		expect((parts.rows[0] as { n: number }).n).toBe(0);
		/* No dangling reference class left behind. */
		const dangling = await db.execute(
			`SELECT count(*)::int AS n FROM conversations WHERE community_id = ${communityA}`,
		);
		expect((dangling.rows[0] as { n: number }).n).toBe(0);
	});
});
