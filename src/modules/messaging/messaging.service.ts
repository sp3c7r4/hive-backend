import { throwBadRequestError, throwForbiddenError, throwNotFoundError, throwRateLimitError } from "@/helpers/errors/throw-errors";
import { serviceLogger } from "@/utils";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { users } from "@/modules/user/user.model";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import { CacheService } from "@/services/cache.service";
import { withPresignedUrl } from "@/helpers/storage.helper";
import { MessageType } from "@/enums";
import { ChatPubSubService } from "@/services/engine/chat-pubsub.service";
import { MessagingRepository } from "./messaging.repository";
import { MessagingMessages as MSG } from "./messaging.message";
import { toConversationDto, toMessageDto } from "./messaging.dto";

export class MessagingService {
	private static instance: MessagingService;

	static getInstance(): MessagingService {
		if (!this.instance) this.instance = new MessagingService();
		return this.instance;
	}

	private repo: MessagingRepository;
	private pubsub: ChatPubSubService;
	private readonly log = serviceLogger("Messaging");

	private constructor() {
		this.repo = MessagingRepository.getInstance();
		this.pubsub = ChatPubSubService.getInstance();
	}

	/* Conversation: create / list */

	createConversation = async (authData: IAuthData, participantId: number) => {
		if (participantId === authData.id) throwBadRequestError(MSG.CANNOT_MESSAGE_SELF);

		const existing = await this.repo.findDirectBetween(authData.id, participantId);
		if (existing) return this.loadConversationDto(existing.id, authData.id);

		const recipient = await this.findUser(participantId);
		const [myRole, theirRole] = await Promise.all([
			this.repo.getPrimaryRole(authData.id),
			this.repo.getPrimaryRole(participantId),
		]);
		const conversation = await this.repo.createDirect(
			authData.id,
			myRole ?? "student",
			participantId,
			theirRole ?? "student",
		);
		this.log.info(`Conversation ${conversation!.id} created between ${authData.id} and ${participantId}`);
		return this.loadConversationDto(conversation!.id, authData.id, {
			id: recipient.id, firstName: recipient.firstName, lastName: recipient.lastName, email: recipient.email,
		});
	};

	list = async (authData: IAuthData) => {
		/* Joined communities automatically get their group chat */
		await this.ensureCommunityChats(authData.id);
		const rows = await this.repo.listForUser(authData.id);
		return rows.map((r) => toConversationDto(r));
	};

	/** User search for the New Message dialog (excludes self, limit 8). */
	searchUsers = async (authData: IAuthData, q: string) => {
		if (!q.trim()) return [];
		const rows = await this.repo.searchUsers(authData.id, q.trim());
		return rows.map((u) =>
			withPresignedUrl(u as any, "avatarUrl"),
		);
	};

	/* Messages: list / send / read / delete */

	listMessages = async (
		authData: IAuthData,
		conversationId: number,
		before?: number,
		limit = 30,
	) => {
		await this.ensureParticipant(conversationId, authData.id);
		const rows = await this.repo.listMessages(conversationId, before, limit);
		const hasMore = rows.length > limit;
		const page = hasMore ? rows.slice(0, limit) : rows;
		// Return ascending (oldest → newest) for the chat pane
		page.reverse();
		return {
			data: page.map((r) => toMessageDto(r)),
			meta: { hasMore, nextBefore: hasMore ? page[0]?.id : null },
		};
	};

	send = async (
		authData: IAuthData,
		body: { recipientId?: number; communityId?: number; content?: string; attachmentUrl?: string; attachmentType?: string },
	) => {
		if (body.recipientId === authData.id) throwBadRequestError(MSG.CANNOT_MESSAGE_SELF);
		if (!body.content?.trim() && !body.attachmentUrl) {
			throwBadRequestError(MSG.CONTENT_REQUIRED);
		}

		await this.enforceRateLimit(authData.id);

		/* Community chat branch */
		if (body.communityId) {
			return this.sendToCommunity(authData, {
				communityId: body.communityId,
				content: body.content,
				attachmentUrl: body.attachmentUrl,
				attachmentType: body.attachmentType,
			});
		}
		if (!body.recipientId) throwBadRequestError(MSG.RECIPIENT_NOT_FOUND);

		const recipientId: number = body.recipientId!;
		const recipient = await this.findUser(recipientId);

		let conversation = await this.repo.findDirectBetween(authData.id, recipientId);
		if (!conversation) {
			const [myRole, theirRole] = await Promise.all([
				this.repo.getPrimaryRole(authData.id),
				this.repo.getPrimaryRole(recipientId),
			]);
			conversation = await this.repo.createDirect(
				authData.id,
				myRole ?? "student",
				recipientId,
				theirRole ?? "student",
			);
		}

		const type = (body.attachmentType as MessageType) ?? MessageType.TEXT;
		const message = await this.repo.insertMessage({
			conversationId: conversation!.id,
			senderId: authData.id,
			type,
			content: sanitizeContent(body.content) || null,
			attachmentUrl: body.attachmentUrl ?? null,
		});

		this.log.info(`Message ${message!.id} sent in conversation ${conversation!.id}`);

		/* Real-time fan-out: recipient + sender's other devices.
		 * `peer` is the OTHER user from each receiver's perspective:
		 * recipient sees the sender, sender sees the recipient. */
		const messageDto = toMessageDto(message);
		const senderAsPeer = {
			id: authData.id,
			firstName: authData.firstName ?? "",
			lastName: authData.lastName ?? "",
			email: authData.email ?? "",
		};
		const recipientAsPeer = {
			id: recipient.id,
			firstName: recipient.firstName,
			lastName: recipient.lastName,
			email: recipient.email,
		};
		const envelopeFor = (peer: any) => ({
			timestamp: new Date().toISOString(),
			status: 200,
			success: true,
			data: {
				type: "message:new",
				payload: {
					message: messageDto,
					conversation: { id: conversation!.id, peer },
				},
			},
		});
		await Promise.allSettled([
			this.pubsub.publishUser(recipientId, envelopeFor(senderAsPeer)),
			this.pubsub.publishUser(authData.id, envelopeFor(recipientAsPeer)),
		]);
		await this.publishConversationUpdated(conversation!.id, [authData.id, recipientId]);

		return {
			message: messageDto,
			conversation: {
				id: conversation!.id,
				peer: { id: recipient.id, firstName: recipient.firstName, lastName: recipient.lastName, email: recipient.email },
			},
		};
	};

	markRead = async (authData: IAuthData, conversationId: number) => {
		await this.ensureParticipant(conversationId, authData.id);
		await this.repo.markRead(conversationId, authData.id);

		/* Real-time read receipt to both parties (syncs other tabs too) */
		const peerId = await this.repo.getPeerId(conversationId, authData.id);
		const envelope = {
			timestamp: new Date().toISOString(),
			status: 200,
			success: true,
			data: {
				type: "message:read",
				payload: {
					conversationId,
					readBy: authData.id,
					readAt: new Date().toISOString(),
				},
			},
		};
		await Promise.allSettled([
			this.pubsub.publishUser(authData.id, envelope),
			...(peerId ? [this.pubsub.publishUser(peerId, envelope)] : []),
		]);
		return { conversationId };
	};

	remove = async (authData: IAuthData, messageId: number) => {
		const message = await this.repo.findMessage(messageId);
		if (!message) throwNotFoundError("Message not found");
		if (message!.senderId !== authData.id) throwForbiddenError(MSG.NOT_MESSAGE_OWNER);
		const deleted = (await this.repo.softDeleteMessage(messageId))!;

		/* Real-time delete to every participant */
		const participants = await this.repo.getParticipantIds(deleted.conversationId);
		const envelope = {
			timestamp: new Date().toISOString(),
			status: 200,
			success: true,
			data: {
				type: "message:deleted",
				payload: { conversationId: deleted.conversationId, messageId: deleted.id },
			},
		};
		await Promise.allSettled(participants.map((pid) => this.pubsub.publishUser(pid, envelope)));

		return { messageId: deleted.id, conversationId: deleted.conversationId };
	};

	/* ── Helpers ───────────────────────────────────────────── */

	private ensureParticipant = async (conversationId: number, userId: number) => {
		const ok = await this.repo.isParticipant(conversationId, userId);
		if (!ok) throwForbiddenError(MSG.NOT_A_PARTICIPANT);
		return ok;
	};

	/** @info - Send a message to a community's group chat (all active members). */
	private sendToCommunity = async (
		authData: IAuthData,
		body: { communityId: number; content?: string; attachmentUrl?: string; attachmentType?: string },
	) => {
		const info = await this.repo.getCommunityInfo(body.communityId);
		if (!info) throwNotFoundError("Community not found");
		const title = info!.name;

		await this.repo.ensureCommunityConversation(body.communityId, title);
		const conversation = (await this.repo.findCommunityConversation(body.communityId))!;
		if (!conversation) throwNotFoundError(MSG.NOT_FOUND);

		/* Sender must be an active member (participant was just ensured) */
		const ok = await this.repo.isParticipant(conversation.id, authData.id);
		if (!ok) throwForbiddenError("You are not a member of this community");

		const type = (body.attachmentType as MessageType) ?? MessageType.TEXT;
		const message = await this.repo.insertMessage({
			conversationId: conversation.id,
			senderId: authData.id,
			type,
			content: sanitizeContent(body.content) || null,
			attachmentUrl: body.attachmentUrl ?? null,
		});

		const participants = await this.repo.getParticipantIds(conversation.id);
		const messageDto = toMessageDto(message);
		const conversationForPayload = {
			id: conversation.id,
			communityId: conversation.communityId ?? body.communityId,
			title: conversation.title ?? title,
			avatarUrl: info!.coverImageUrl
				? withPresignedUrl({ coverImageUrl: info!.coverImageUrl }, "coverImageUrl").coverImageUrl
				: null,
			peer: null as null,
		};
		const envelope = {
			timestamp: new Date().toISOString(),
			status: 200,
			success: true,
			data: {
				type: "message:new",
				payload: {
					message: messageDto,
					conversation: conversationForPayload,
				},
			},
		};
		await Promise.allSettled(participants.map((pid) => this.pubsub.publishUser(pid, envelope)));
		await this.publishConversationUpdated(conversation.id, participants);

		return {
			message: messageDto,
			conversation: conversationForPayload,
		};
	};

	/** @info - Hint other surfaces to refresh the conversation list (previews). */
	private publishConversationUpdated = async (conversationId: number, userIds: number[]) => {
		const envelope = {
			timestamp: new Date().toISOString(),
			status: 200,
			success: true,
			data: {
				type: "conversation:updated",
				payload: { conversationId, lastMessageAt: new Date().toISOString() },
			},
		};
		await Promise.allSettled(userIds.map((pid) => this.pubsub.publishUser(pid, envelope)));
	};

	/** @info - Leave a conversation (soft: leftAt now — hidden from my list). */
	leaveConversation = async (authData: IAuthData, conversationId: number) => {
		await this.ensureParticipant(conversationId, authData.id);
		await this.repo.leaveConversation(conversationId, authData.id);
		return { conversationId };
	};

	/** @info - Create/backfill the group chat for every joined community. */
	private ensureCommunityChats = async (userId: number) => {
		try {
			const memberships = await this.repo.getCommunityMemberships(userId);
			await Promise.allSettled(
				memberships.map((m) => this.repo.ensureCommunityConversation(m.communityId, m.name)),
			);
		} catch {
			/* chat ensure must never break the list */
		}
	};

	/** @info - Sliding-window rate limit: max 30 messages/min/user via Redis. */
	private enforceRateLimit = async (userId: number) => {
		const redis = CacheService.getInstance().getRedisClient();
		const key = `ratelimit:msg:${userId}`;
		const count = await redis.incr(key);
		if (count === 1) await redis.expire(key, 60);
		if (count > 30) {
			throwRateLimitError("You are sending messages too fast. Please wait a minute.");
		}
	};

	/* @info - Strip angle-bracket HTML and control chars; plain text only. */
	private findUser = async (userId: number): Promise<{ id: number; firstName: string; lastName: string; email: string }> => {
		const db = getDb();
		const [user] = await db
			.select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email })
			.from(users)
			.where(eq(users.id, userId))
			.limit(1);
		if (!user) throwNotFoundError(MSG.RECIPIENT_NOT_FOUND);
		return user as { id: number; firstName: string; lastName: string; email: string };
	};

	/** Load the full DTO for one of my conversations (falls back to a bare shape). */
	private loadConversationDto = async (conversationId: number, userId: number, fallbackPeer?: any) => {
		const [row] = await this.repo.listForUser(userId, conversationId);
		if (row) return toConversationDto(row);
		return {
			id: conversationId,
			type: "direct" as const,
			title: null,
			communityId: null,
			lastMessageAt: null,
			createdAt: null,
			unreadCount: 0,
			peer: fallbackPeer ?? null,
			lastMessage: null,
		};
	};
}

/** @info - Plain-text only: strip tags + control chars before persisting. */
const sanitizeContent = (content?: string) =>
	(content ?? "")
		.replace(/<[^>]*>/g, "")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
		.trim();
