import { withPresignedUrl } from "@/helpers/storage.helper";

/** @info - Wire shapes for conversation + message DTOs (API responses). */

type ConversationRow = {
	id: number;
	type: string;
	title: string | null;
	communityId: number | null;
	coverImageUrl?: string | null;
	lastMessageAt: Date | null;
	createdAt: Date | null;
	myLastReadAt?: Date | null;
	peerLastReadAt?: Date | null;
	peerId?: number | null;
	peerFirstName?: string;
	peerLastName?: string;
	peerEmail?: string;
	peerAvatarUrl?: string | null;
	lastMessage: any;
	unreadCount: number;
};

type MessageRow = {
	id: number;
	conversationId: number;
	senderId: number;
	type: string;
	content: string | null;
	attachmentUrl: string | null;
	readAt: Date | null;
	createdAt: Date | null;
	deletedAt: Date | null;
	senderFirstName?: string;
	senderLastName?: string;
	senderEmail?: string;
	senderAvatarUrl?: string | null;
};

const toPeerDto = (row: ConversationRow) =>
	withPresignedUrl(
		{
			id: row.peerId!,
			firstName: row.peerFirstName ?? "",
			lastName: row.peerLastName ?? "",
			email: row.peerEmail ?? "",
			avatarUrl: row.peerAvatarUrl ?? null,
		},
		"avatarUrl",
	);

export const toConversationDto = (row: ConversationRow) => ({
	id: row.id,
	type: row.type,
	title: row.title,
	communityId: row.communityId ?? null,
	avatarUrl: row.type === "group"
		? row.coverImageUrl
			? withPresignedUrl({ coverImageUrl: row.coverImageUrl }, "coverImageUrl").coverImageUrl
			: null
		: null,
	lastMessageAt: row.lastMessageAt,
	createdAt: row.createdAt,
	unreadCount: row.unreadCount,
	peerLastReadAt: row.peerLastReadAt ?? null,
	peer: row.type === "group" ? null : toPeerDto(row),
	lastMessage: row.lastMessage
		? {
				id: row.lastMessage.id,
				type: row.lastMessage.type,
				content: row.lastMessage.content,
				attachmentUrl: row.lastMessage.attachmentUrl
					? withPresignedUrl({ attachmentUrl: row.lastMessage.attachmentUrl }, "attachmentUrl")
							.attachmentUrl
					: null,
				senderId: row.lastMessage.senderId,
				createdAt: row.lastMessage.createdAt,
			}
		: null,
});

export const toMessageDto = (m: any) => ({
	id: m.id,
	conversationId: m.conversationId,
	senderId: m.senderId,
	type: m.type,
	content: m.content,
	attachmentUrl: m.attachmentUrl
		? withPresignedUrl({ attachmentUrl: m.attachmentUrl }, "attachmentUrl").attachmentUrl
		: null,
	readAt: m.readAt,
	createdAt: m.createdAt,
	deletedAt: m.deletedAt,
	sender: m.senderId
		? {
				id: m.senderId,
				firstName: m.senderFirstName,
				lastName: m.senderLastName,
				email: m.senderEmail,
				avatarUrl: m.senderAvatarUrl
					? withPresignedUrl({ avatarUrl: m.senderAvatarUrl }, "avatarUrl").avatarUrl
					: null,
			}
		: undefined,
});
