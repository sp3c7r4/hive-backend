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
import {
	ConversationType,
	MessageType,
	UserRole,
	TableNames,
} from "@/enums";
import { softDelete } from "@/models/soft-delete.model";
import { timestamps } from "@/models/timestamps.b.model";

const conversationTypeEnum = pgEnum("conversation_type", Object.values(ConversationType) as [string, ...string[]]);
const messageTypeEnum = pgEnum("message_type", Object.values(MessageType) as [string, ...string[]]);
const userRoleEnum = pgEnum("user_role", Object.values(UserRole) as [string, ...string[]]);

/** @info - Direct or group conversation */
export const conversations = pgTable(
	TableNames.CONVERSATIONS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		type: conversationTypeEnum("type").default("direct").notNull(),
		/** @info - Only for group conversations */
		title: varchar("title", { length: 255 }),
		lastMessageAt: timestamp("last_message_at"),
		...timestamps,
	},
	(table) => [
		index("idx_conversations_type").on(table.type),
	],
);

/** @info - Polymorphic participant — entityId + entityType references the role table */
export const conversationParticipants = pgTable(
	TableNames.CONVERSATION_PARTICIPANTS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		conversationId: integer("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		/** @info - ID of the participant in their role table */
		entityId: integer("entity_id").notNull(),
		/** @info - Which role table entityId refers to */
		entityType: userRoleEnum("entity_type").notNull(),
		joinedAt: timestamp("joined_at").defaultNow().notNull(),
		leftAt: timestamp("left_at"),
	},
	(table) => [
		uniqueIndex("uq_conversation_participant").on(table.conversationId, table.entityId, table.entityType),
		index("idx_conversation_participants_conversation").on(table.conversationId),
		index("idx_conversation_participants_entity").on(table.entityId, table.entityType),
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
		/** @info - ID of the sender in their role table */
		senderId: integer("sender_id").notNull(),
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
}));

export const messagesRelations = relations(messages, ({ one }) => ({
	conversation: one(conversations, {
		fields: [messages.conversationId],
		references: [conversations.id],
	}),
}));
