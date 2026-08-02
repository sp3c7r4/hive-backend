import {
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	timestamp,
	varchar,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { users } from "@/models/user.model";
import { userRoleEnum } from "@/bases/models/base.user.model";
import {
	NotificationType,
	TableNames,
} from "@/enums";
import { timestamps } from "@/models/timestamps.b.model";

export const notificationTypeEnum = pgEnum("notification_type", Object.values(NotificationType) as [string, ...string[]]);

/** @info - Notification linked to a user. Role column provides context (student/instructor/parent). */
export const notifications = pgTable(
	TableNames.NOTIFICATIONS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		role: userRoleEnum("role").notNull(),
		type: notificationTypeEnum("type").notNull(),
		title: varchar("title", { length: 255 }).notNull(),
		message: varchar("message", { length: 1000 }).notNull(),
		metadata: jsonb("metadata").default({}),
		readAt: timestamp("read_at"),
		...timestamps,
	},
	(table) => [
		index("idx_notifications_user").on(table.userId),
		index("idx_notifications_type").on(table.type),
		index("idx_notifications_read_at").on(table.readAt),
	],
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

/** @info - Relations */
export const notificationsRelations = relations(notifications, ({ one }) => ({
	user: one(users, {
		fields: [notifications.userId],
		references: [users.id],
	}),
}));
