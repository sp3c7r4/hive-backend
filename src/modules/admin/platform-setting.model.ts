/**
 * @info - Platform-level key/value settings (certificate director block etc).
 * Values are plain text; the admin module owns read/write.
 */
import { pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { TableNames } from "@/enums";

export const platformSettings = pgTable(TableNames.PLATFORM_SETTINGS, {
	id: serial("id").primaryKey(),
	key: varchar("key", { length: 100 }).notNull().unique(),
	value: text("value").notNull(),
	updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type PlatformSetting = typeof platformSettings.$inferSelect;
export type NewPlatformSetting = typeof platformSettings.$inferInsert;
