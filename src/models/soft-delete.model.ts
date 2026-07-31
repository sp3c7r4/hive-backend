import { timestamp } from "drizzle-orm/pg-core";

export const softDelete = {
	deleted_at: timestamp("deleted_at"),
};
