import {
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	timestamp,
	varchar,
} from "drizzle-orm/pg-core";
import {
	NotificationType,
	TableNames,
} from "@/enums";
import { userRoleEnum } from "@/bases/models/base.user.model";
import { timestamps } from "@/models/timestamps.b.model";

export const notificationTypeEnum = pgEnum("notification_type", Object.values(NotificationType) as [string, ...string[]]);

/** @info - Polymorphic notification — entityId + entityType references the recipient's role table */
export const notifications = pgTable(
	TableNames.NOTIFICATIONS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		/** @info - ID of the recipient in their role table */
		entityId: integer("entity_id").notNull(),
		/** @info - Which role table entityId refers to */
		entityType: userRoleEnum("entity_type").notNull(),
		type: notificationTypeEnum("type").notNull(),
		title: varchar("title", { length: 255 }).notNull(),
		message: varchar("message", { length: 1000 }).notNull(),
		metadata: jsonb("metadata").default({}),
		readAt: timestamp("read_at"),
		...timestamps,
	},
	(table) => [
		index("idx_notifications_entity").on(table.entityId, table.entityType),
		index("idx_notifications_type").on(table.type),
		index("idx_notifications_read_at").on(table.readAt),
	],
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

/** @info - Relations: none. Notification entityId + entityType is polymorphic — no direct FK to a single role table. */
