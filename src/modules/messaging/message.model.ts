import {
	index,
	integer,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { users } from "@/modules/user/user.model";
import { userRoleEnum } from "@/bases/models/base.user.model";
import {
	ConversationType,
	MessageType,
	TableNames,
} from "@/enums";
import { softDelete } from "@/models/soft-delete.model";
import { timestamps } from "@/models/timestamps.b.model";

export const conversationTypeEnum = pgEnum("conversation_type", Object.values(ConversationType) as [string, ...string[]]);
export const messageTypeEnum = pgEnum("message_type", Object.values(MessageType) as [string, ...string[]]);

/** @info - Direct or group conversation */
export const conversations = pgTable(
	TableNames.CONVERSATIONS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		type: conversationTypeEnum("type").default("direct").notNull(),
		title: varchar("title", { length: 255 }),
		communityId: integer("community_id"),
		lastMessageAt: timestamp("last_message_at"),
		...timestamps,
	},
	(table) => [
		index("idx_conversations_type").on(table.type),
		index("idx_conversations_community").on(table.communityId),
	],
);

/** @info - Links a user to a conversation. Role column provides context (student/instructor/parent). */
export const conversationParticipants = pgTable(
	TableNames.CONVERSATION_PARTICIPANTS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		conversationId: integer("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		role: userRoleEnum("role").notNull(),
		joinedAt: timestamp("joined_at").defaultNow().notNull(),
		leftAt: timestamp("left_at"),
		lastReadAt: timestamp("last_read_at"),
	},
	(table) => [
		uniqueIndex("uq_conversation_participant").on(table.conversationId, table.userId),
		index("idx_conversation_participants_conversation").on(table.conversationId),
		index("idx_conversation_participants_user").on(table.userId),
	],
);

/** @info - Single message in a conversation */
export const messages = pgTable(
	TableNames.MESSAGES,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		conversationId: integer("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		senderId: integer("sender_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		type: messageTypeEnum("type").default("text").notNull(),
		content: text("content"),
		attachmentUrl: varchar("attachment_url", { length: 1000 }),
		readAt: timestamp("read_at"),
		...timestamps,
		...softDelete,
	},
	(table) => [
		index("idx_messages_conversation").on(table.conversationId),
		index("idx_messages_sender").on(table.senderId),
		index("idx_messages_read_at").on(table.readAt),
	],
);

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type ConversationParticipant = typeof conversationParticipants.$inferSelect;
export type NewConversationParticipant = typeof conversationParticipants.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

/** @info - Relations */
export const conversationsRelations = relations(conversations, ({ many }) => ({
	participants: many(conversationParticipants),
	messages: many(messages),
}));

export const conversationParticipantsRelations = relations(conversationParticipants, ({ one }) => ({
	conversation: one(conversations, {
		fields: [conversationParticipants.conversationId],
		references: [conversations.id],
	}),
	user: one(users, {
		fields: [conversationParticipants.userId],
		references: [users.id],
	}),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
	conversation: one(conversations, {
		fields: [messages.conversationId],
		references: [conversations.id],
	}),
	sender: one(users, {
		fields: [messages.senderId],
		references: [users.id],
	}),
}));
