import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { timestamps } from "@/models/timestamps.b.model";

export const test = pgTable("tests", {
	id: serial("id").primaryKey(),
	name: text("name").notNull(),
	description: text("description"),
	...timestamps,
});

export type Test = typeof test.$inferSelect;
export type NewTest = typeof test.$inferInsert;
