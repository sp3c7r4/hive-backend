import { and, asc, eq, gt, ilike, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "@/db/postgres.db";
import { user_roles } from "@/modules/user/user-role.model";
import { users } from "@/modules/user/user.model";
import { communityMembers, communities } from "@/modules/communities/community.model";
import {
	conversationParticipants,
	conversations,
	messages,
} from "./message.model";

/** @info - Data access for conversations, participants and messages. */
export class MessagingRepository {
	private static instance: MessagingRepository;

	static getInstance(): MessagingRepository {
		if (!this.instance) this.instance = new MessagingRepository();
		return this.instance;
	}

	private constructor() {}

	/* ── Conversations ────────────────────────────────────── */

	/** Find an existing active direct conversation between two users. */
	findDirectBetween = async (userIdA: number, userIdB: number) => {
		const db = getDb();
		const p1 = alias(conversationParticipants, "p1");
		const p2 = alias(conversationParticipants, "p2");
		const [row] = await db
			.select({ conversation: conversations })
			.from(conversations)
			.innerJoin(p1, and(eq(p1.conversationId, conversations.id), eq(p1.userId, userIdA)))
			.innerJoin(p2, and(eq(p2.conversationId, conversations.id), eq(p2.userId, userIdB)))
			.where(and(eq(conversations.type, "direct"), isNull(p1.leftAt), isNull(p2.leftAt)))
			.limit(1);
		return row?.conversation;
	};

	/**
	 * @info - Find-or-create the direct thread between two users, with both of them
	 *          as participants. Serialized by a transaction-scoped advisory lock on
	 *          the ordered user pair and re-checked inside that lock: two concurrent
	 *          "New Message" taps used to insert two threads, the same race as the
	 *          community group chats. Returns the existing thread when there is one.
	 */
	createDirect = async (
		userIdA: number,
		roleA: string,
		userIdB: number,
		roleB: string,
	) => {
		const db = getDb();
		const pairKey = `${Math.min(userIdA, userIdB)}-${Math.max(userIdA, userIdB)}`;

		const conversation = await db.transaction(async (tx) => {
			/* @info - xact lock: released on commit/rollback, so the re-check below
			 *         sees any thread the racing request already committed. */
			await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${pairKey}))`);

			const p1 = alias(conversationParticipants, "p1");
			const p2 = alias(conversationParticipants, "p2");
			const [existing] = await tx
				.select({ conversation: conversations })
				.from(conversations)
				.innerJoin(
					p1,
					and(eq(p1.conversationId, conversations.id), eq(p1.userId, userIdA)),
				)
				.innerJoin(
					p2,
					and(eq(p2.conversationId, conversations.id), eq(p2.userId, userIdB)),
				)
				.where(
					and(
						eq(conversations.type, "direct"),
						isNull(p1.leftAt),
						isNull(p2.leftAt),
					),
				)
				.limit(1);
			if (existing?.conversation) return existing.conversation;

			const [inserted] = await tx
				.insert(conversations)
				.values({ type: "direct" })
				.returning();
			await tx.insert(conversationParticipants).values([
				{ conversationId: inserted!.id, userId: userIdA, role: roleA as any },
				{ conversationId: inserted!.id, userId: userIdB, role: roleB as any },
			]);
			return inserted;
		});
		return conversation;
	};

	/** My conversations with peer user, last-message preview and unread count. */
	listForUser = async (userId: number, conversationId?: number) => {
		const db = getDb();
		const me = alias(conversationParticipants, "me");
		const peer = alias(conversationParticipants, "peer");

		const where = and(eq(me.userId, userId), isNull(me.leftAt), isNull(peer.leftAt));
		const whereWithId = conversationId ? and(where, eq(conversations.id, conversationId)) : where;

		const rows = await db
			.select({
				id: conversations.id,
				type: conversations.type,
				title: conversations.title,
				communityId: conversations.communityId,
				lastMessageAt: conversations.lastMessageAt,
				createdAt: conversations.createdAt,
				myLastReadAt: me.lastReadAt,
				peerLastReadAt: peer.lastReadAt,
				peerId: peer.userId,
				peerFirstName: users.firstName,
				peerLastName: users.lastName,
				peerEmail: users.email,
				peerAvatarUrl: users.avatarUrl,
			})
			.from(me)
			.innerJoin(conversations, eq(conversations.id, me.conversationId))
			.innerJoin(peer, and(eq(peer.conversationId, conversations.id), sql`${peer.userId} <> ${userId}`))
			.innerJoin(users, eq(users.id, peer.userId))
			.where(and(
				whereWithId,
				eq(conversations.type, "direct"),
			))
			.orderBy(sql`${conversations.lastMessageAt} DESC NULLS LAST`);

		/* Group chats: one row per group conversation (no peer join). */
		const groupRows = await db
			.select({
				id: conversations.id,
				type: conversations.type,
				title: conversations.title,
				communityId: conversations.communityId,
				communitySlug: communities.slug,
				coverImageUrl: communities.coverImageUrl,
				lastMessageAt: conversations.lastMessageAt,
				createdAt: conversations.createdAt,
			})
			.from(conversationParticipants)
			.innerJoin(conversations, eq(conversations.id, conversationParticipants.conversationId))
			.leftJoin(communities, eq(communities.id, conversations.communityId))
			.where(and(
				eq(conversationParticipants.userId, userId),
				isNull(conversationParticipants.leftAt),
				eq(conversations.type, "group"),
				conversationId ? eq(conversations.id, conversationId) : undefined,
			))
			.orderBy(sql`${conversations.lastMessageAt} DESC NULLS LAST`);

		const allRows = [
			...rows.map((r) => ({ ...r, isGroup: false })),
			...groupRows.map((r) => ({ ...r, isGroup: true })),
		];

		const ids = allRows.map((r) => r.id);
		if (!ids.length) return [];

		const [lastMessages, unreadRows] = await Promise.all([
			db
				.select({
					conversationId: messages.conversationId,
					id: messages.id,
					content: messages.content,
					type: messages.type,
					attachmentUrl: messages.attachmentUrl,
					createdAt: messages.createdAt,
					senderId: messages.senderId,
					deletedAt: messages.deletedAt,
				})
				.from(messages)
				.where(inArray(messages.conversationId, ids))
				.orderBy(messages.id),
			db
				.select({
					conversationId: messages.conversationId,
					count: sql<number>`count(*)::int`,
				})
				.from(messages)
				.innerJoin(
					conversationParticipants,
					and(
						eq(conversationParticipants.conversationId, messages.conversationId),
						eq(conversationParticipants.userId, userId),
					),
				)
				.where(and(
					inArray(messages.conversationId, ids),
					isNull(messages.deletedAt),
					sql`${messages.senderId} <> ${userId}`,
					or(
						isNull(conversationParticipants.lastReadAt),
						gt(messages.createdAt, conversationParticipants.lastReadAt),
					),
				))
				.groupBy(messages.conversationId),
		]);

		const lastByConv = new Map<number, (typeof lastMessages)[number]>();
		for (const m of lastMessages) lastByConv.set(m.conversationId, m);
		const unreadByConv = new Map<number, number>();
		for (const u of unreadRows) unreadByConv.set(u.conversationId, u.count);

		return allRows.map((r) => ({
			...r,
			lastMessage: lastByConv.get(r.id) ?? null,
			unreadCount: unreadByConv.get(r.id) ?? 0,
		}));
	};

	/** Messages for a conversation — newest-first cursor page (limit+1 tells if more). */
	listMessages = async (conversationId: number, before?: number, limit = 30) => {
		const db = getDb();
		const conditions = [eq(messages.conversationId, conversationId)];
		if (before) conditions.push(lt(messages.id, before));
		const deleter = alias(users, "deleter");

		return db
			.select({
				id: messages.id,
				conversationId: messages.conversationId,
				senderId: messages.senderId,
				type: messages.type,
				content: messages.content,
				attachmentUrl: messages.attachmentUrl,
				durationMs: messages.durationMs,
				readAt: messages.readAt,
				createdAt: messages.createdAt,
				deletedAt: messages.deletedAt,
				deletedBy: messages.deletedBy,
				senderFirstName: users.firstName,
				senderLastName: users.lastName,
				senderEmail: users.email,
				senderAvatarUrl: users.avatarUrl,
				deletedByFirstName: deleter.firstName,
				deletedByLastName: deleter.lastName,
				deletedByEmail: deleter.email,
			})
			.from(messages)
			.innerJoin(users, eq(users.id, messages.senderId))
			.leftJoin(deleter, eq(deleter.id, messages.deletedBy))
			.where(and(...conditions))
			.orderBy(sql`${messages.id} DESC`)
			.limit(limit + 1);
	};

	findMessage = async (messageId: number) => {
		const db = getDb();
		const [row] = await db
			.select()
			.from(messages)
			.where(eq(messages.id, messageId))
			.limit(1);
		return row;
	};

	insertMessage = async (data: {
		conversationId: number;
		senderId: number;
		type: string;
		content?: string | null;
		attachmentUrl?: string | null;
		durationMs?: number | null;
	}) => {
		const db = getDb();
		const message = await db.transaction(async (tx) => {
			const [inserted] = await tx
				.insert(messages)
				.values({
					conversationId: data.conversationId,
					senderId: data.senderId,
					type: data.type as any,
					content: data.content ?? null,
					attachmentUrl: data.attachmentUrl ?? null,
					durationMs: data.durationMs ?? null,
				})
				.returning();
			await tx
				.update(conversations)
				.set({ lastMessageAt: new Date() })
				.where(eq(conversations.id, data.conversationId));
			return inserted;
		});
		return message;
	};

	/** @info - Shared media for the media tabs: images / documents / audio files. */
	listMediaAttachments = async (conversationId: number, types: string[], limit = 60) => {
		const db = getDb();
		if (types.length === 0) return [];
		return db
			.select({
				id: messages.id,
				conversationId: messages.conversationId,
				senderId: messages.senderId,
				type: messages.type,
				content: messages.content,
				attachmentUrl: messages.attachmentUrl,
				durationMs: messages.durationMs,
				readAt: messages.readAt,
				createdAt: messages.createdAt,
				deletedAt: messages.deletedAt,
			})
			.from(messages)
			.where(and(
				eq(messages.conversationId, conversationId),
				isNull(messages.deletedAt),
				inArray(messages.type, types as any),
			))
			.orderBy(sql`${messages.id} DESC`)
			.limit(limit);
	};

	/** @info - Messages whose text contains at least one URL (Links tab). */
	listLinkMessages = async (conversationId: number, limit = 60) => {
		const db = getDb();
		return db
			.select({
				id: messages.id,
				conversationId: messages.conversationId,
				senderId: messages.senderId,
				type: messages.type,
				content: messages.content,
				attachmentUrl: messages.attachmentUrl,
				durationMs: messages.durationMs,
				readAt: messages.readAt,
				createdAt: messages.createdAt,
				deletedAt: messages.deletedAt,
			})
			.from(messages)
			.where(and(
				eq(messages.conversationId, conversationId),
				isNull(messages.deletedAt),
				sql`${messages.content} ILIKE '%http%'`,
			))
			.orderBy(sql`${messages.id} DESC`)
			.limit(limit);
	};

	isParticipant = async (conversationId: number, userId: number) => {
		const db = getDb();
		const [row] = await db
			.select({ id: conversationParticipants.id })
			.from(conversationParticipants)
			.where(and(
				eq(conversationParticipants.conversationId, conversationId),
				eq(conversationParticipants.userId, userId),
				isNull(conversationParticipants.leftAt),
			))
			.limit(1);
		return !!row;
	};

	markRead = async (conversationId: number, userId: number) => {
		const db = getDb();
		await db
			.update(conversationParticipants)
			.set({ lastReadAt: new Date() })
			.where(and(
				eq(conversationParticipants.conversationId, conversationId),
				eq(conversationParticipants.userId, userId),
			));
	};

	getParticipant = async (conversationId: number, userId: number) => {
		const db = getDb();
		const [row] = await db
			.select()
			.from(conversationParticipants)
			.where(and(
				eq(conversationParticipants.conversationId, conversationId),
				eq(conversationParticipants.userId, userId),
			))
			.limit(1);
		return row;
	};

	/** Search users by name/email (excludes the caller). */
	searchUsers = async (userId: number, q: string, limit = 8) => {
		const db = getDb();
		const pattern = `%${q}%`;
		return db
			.select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email, avatarUrl: users.avatarUrl })
			.from(users)
			.where(and(
				sql`${users.id} <> ${userId}`,
				or(
					ilike(users.firstName, pattern),
					ilike(users.lastName, pattern),
					ilike(users.email, pattern),
				),
			))
			.orderBy(users.firstName)
			.limit(limit);
	};

	/** First role for a user from user_roles (participant table needs one on insert). */
	getPrimaryRole = async (userId: number) => {
		const db = getDb();
		const [row] = await db
			.select({ role: user_roles.role })
			.from(user_roles)
			.where(eq(user_roles.userId, userId))
			.orderBy(user_roles.id)
			.limit(1);
		return row?.role as string | undefined;
	};

	/** The other participant's id in a conversation (direct chats only). */
	getPeerId = async (conversationId: number, userId: number) => {
		const db = getDb();
		const [row] = await db
			.select({ userId: conversationParticipants.userId })
			.from(conversationParticipants)
			.where(and(
				eq(conversationParticipants.conversationId, conversationId),
				sql`${conversationParticipants.userId} <> ${userId}`,
				isNull(conversationParticipants.leftAt),
			))
			.limit(1);
		return row?.userId;
	};

	/** All participant ids of a conversation (for fan-out deletes). */
	getParticipantIds = async (conversationId: number) => {
		const db = getDb();
		const rows = await db
			.select({ userId: conversationParticipants.userId })
			.from(conversationParticipants)
			.where(eq(conversationParticipants.conversationId, conversationId));
		return rows.map((r) => r.userId);
	};

	/** Soft-leave: set leftAt so the user's list stops showing this conversation. */
	leaveConversation = async (conversationId: number, userId: number) => {
		const db = getDb();
		await db
			.update(conversationParticipants)
			.set({ leftAt: new Date() })
			.where(and(
				eq(conversationParticipants.conversationId, conversationId),
				eq(conversationParticipants.userId, userId),
			));
	};

	/** @info - Insert a system message (e.g. "X joined the community"). */
	insertSystemMessage = async (conversationId: number, senderId: number, content: string) => {
		const db = getDb();
		const [row] = await db
			.insert(messages)
			.values({ conversationId, senderId, type: "system" as any, content })
			.returning();
		return row;
	};

	/* ── Community (group) chats ──────────────────────────── */

	/** The user's active community memberships (id + name, non-archived). */
	getCommunityMemberships = async (userId: number) => {		const db = getDb();
		return db
			.select({ communityId: communities.id, name: communities.name })
			.from(communityMembers)
			.innerJoin(communities, eq(communities.id, communityMembers.communityId))
			.where(and(
				eq(communityMembers.userId, userId),
				eq(communityMembers.status, "active"),
				isNull(communities.deletedAt),
			))
			.orderBy(communities.id);
	};

	/** Community display name + cover (for group chats). */
	/** @info - Membership status of a user in a community (null = not a member). */
	getMembershipStatus = async (communityId: number, userId: number) => {
		const db = getDb();
		const [row] = await db
			.select({ status: communityMembers.status })
			.from(communityMembers)
			.where(
				and(
					eq(communityMembers.communityId, communityId),
					eq(communityMembers.userId, userId),
				),
			)
			.limit(1);
		return (row?.status as string | undefined) ?? null;
	};

	getCommunityInfo = async (communityId: number) => {
		const db = getDb();
		const [row] = await db
			.select({ name: communities.name, coverImageUrl: communities.coverImageUrl })
			.from(communities)
			.where(eq(communities.id, communityId))
			.limit(1);
		return row;
	};

	/** Community display name (for group chat titles). */
	getCommunityName = async (communityId: number) => {
		const db = getDb();
		const [row] = await db
			.select({ name: communities.name })
			.from(communities)
			.where(eq(communities.id, communityId))
			.limit(1);
		return row?.name;
	};

	/** Active member ids of a community. */
	getActiveMemberIds = async (communityId: number) => {
		const db = getDb();
		const rows = await db
			.select({ userId: communityMembers.userId })
			.from(communityMembers)
			.where(and(
				eq(communityMembers.communityId, communityId),
				eq(communityMembers.status, "active"),
			));
		return rows.map((r) => r.userId);
	};

	/** Find the group conversation for a community (if any). */
	findCommunityConversation = async (communityId: number) => {
		const db = getDb();
		const [row] = await db
			.select()
			.from(conversations)
			.where(and(
				eq(conversations.communityId, communityId),
				eq(conversations.type, "group"),
			))
			.limit(1);
		return row;
	};

	/**
	 * @info - Ensure a community's group chat exists and every active member is
	 *          a participant. Safe to call on every list/send, and safe to call
	 *          concurrently: the insert is guarded by the partial unique index
	 *          uq_conversations_community_group (migration 0026), so racing
	 *          callers collapse onto one row instead of each creating a chat.
	 *          A participant who has left is NOT re-joined — the unique
	 *          (conversation, user) row already exists, so onConflictDoNothing
	 *          leaves their left_at untouched.
	 */
	ensureCommunityConversation = async (communityId: number, title: string) => {
		const db = getDb();
		const memberIds = await this.getActiveMemberIds(communityId);

		const inserted = await db.transaction(async (tx) => {
			const [row] = await tx
				.insert(conversations)
				.values({ type: "group", title, communityId })
				.onConflictDoNothing()
				.returning();
			if (!row) return null;

			if (memberIds.length) {
				await tx
					.insert(conversationParticipants)
					.values(
						memberIds.map((uid) => ({
							conversationId: row.id,
							userId: uid,
							role: "student" as any,
						})),
					)
					.onConflictDoNothing();
			}
			return row;
		});

		/* @info - Lost the insert race (or the chat already existed): use the
		 *         row that is actually in the table. */
		const conversation =
			inserted ?? (await this.findCommunityConversation(communityId));
		if (!conversation) return conversation;

		if (!inserted && memberIds.length) {
			/* New members may have joined since — backfill participants. */
			await db
				.insert(conversationParticipants)
				.values(
					memberIds.map((uid) => ({
						conversationId: conversation.id,
						userId: uid,
						role: "student" as any,
					})),
				)
				.onConflictDoNothing();
		}
		return conversation;
	};

	softDeleteMessage = async (messageId: number, deletedBy: number) => {
		const db = getDb();
		const [row] = await db
			.update(messages)
			.set({ deletedAt: new Date(), deletedBy })
			.where(eq(messages.id, messageId))
			.returning();
		return row;
	};
}
