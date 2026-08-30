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

	/** Insert a direct conversation + its two participants in a transaction. */
	createDirect = async (
		userIdA: number,
		roleA: string,
		userIdB: number,
		roleB: string,
	) => {
		const db = getDb();
		const conversation = await db.transaction(async (tx) => {
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
				})
				.from(messages)
				.where(and(inArray(messages.conversationId, ids), isNull(messages.deletedAt)))
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
		const conditions = [eq(messages.conversationId, conversationId), isNull(messages.deletedAt)];
		if (before) conditions.push(lt(messages.id, before));

		return db
			.select({
				id: messages.id,
				conversationId: messages.conversationId,
				senderId: messages.senderId,
				type: messages.type,
				content: messages.content,
				attachmentUrl: messages.attachmentUrl,
				readAt: messages.readAt,
				createdAt: messages.createdAt,
				deletedAt: messages.deletedAt,
				senderFirstName: users.firstName,
				senderLastName: users.lastName,
				senderEmail: users.email,
				senderAvatarUrl: users.avatarUrl,
			})
			.from(messages)
			.innerJoin(users, eq(users.id, messages.senderId))
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
	 *          a participant. Idempotent; safe to call on every list/send.
	 */
	ensureCommunityConversation = async (communityId: number, title: string) => {
		const db = getDb();
		let conversation = await this.findCommunityConversation(communityId);
		const memberIds = await this.getActiveMemberIds(communityId);

		const db2 = db;
		if (!conversation) {
			conversation = await db2.transaction(async (tx) => {
				const [inserted] = await tx
					.insert(conversations)
					.values({ type: "group", title, communityId })
					.returning();
				if (memberIds.length) {
					await tx
						.insert(conversationParticipants)
						.values(
							memberIds.map((uid) => ({
								conversationId: inserted!.id,
								userId: uid,
								role: "student" as any,
							})),
						)
						.onConflictDoNothing();
				}
				return inserted;
			});
		} else {
			/* New members may have joined since — backfill participants. */
			await db2
				.insert(conversationParticipants)
				.values(
					memberIds.map((uid) => ({
							conversationId: conversation!.id,
							userId: uid,
							role: "student" as any,
						})),
				)
				.onConflictDoNothing();
		}
		return conversation;
	};

	softDeleteMessage = async (messageId: number) => {
		const db = getDb();
		const [row] = await db
			.update(messages)
			.set({ deletedAt: new Date() })
			.where(eq(messages.id, messageId))
			.returning();
		return row;
	};
}
