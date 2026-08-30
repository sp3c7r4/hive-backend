import { timestamp } from "drizzle-orm/pg-core";

export const softDelete = {
	deletedAt: timestamp("deleted_at"),
};
