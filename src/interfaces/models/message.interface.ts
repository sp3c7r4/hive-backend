import type { Types } from "mongoose";
import type { MessageRole, MessageSenderTypes } from "@/enums";
import type { Attachment } from "./conversation";

export interface IMessage {
	contactBusinessId: Types.ObjectId; // ref → Conversation.id
	platformMessageId?: string;

	// Content
	role: MessageRole; // user | assistant | system | tool
	content: string;
	attachments?: Attachment[];

	// Who actually sent this (for assistant messages during handoff)
	/**
	 * @description
	 * - contact: user chatting with business
	 * - bot: the bot that responded to the message
	 * - human_agent: the human that responded to this message during handoff
	 * - system: a broadcast message
	 */
	sender: {
		senderType: MessageSenderTypes;
		senderId?: string; // ref → Sender.id
	};

	// Tool calls (replaces singular functionCall)
	// toolCalls?: ToolCall[];

	// // Cost tracking (embedded, not a separate metadata object)
	// tokenUsage?: {
	//   prompt: number;
	//   completion: number;
	//   total: number;
	//   cost: number; // USD
	// };

	createdAt: Date;
}
