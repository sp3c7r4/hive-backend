import { index, integer, pgTable, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { TableNames } from "@/enums";
import { users } from "@/modules/user/user.model";
import { communities } from "./community.model";
import { timestamps } from "@/models/timestamps.b.model";

/** @info - One 1-5 star rating per user per community */
export const communityRatings = pgTable(
	TableNames.COMMUNITY_RATINGS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		communityId: integer("community_id")
			.notNull()
			.references(() => communities.id, { onDelete: "cascade" }),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		rating: integer("rating").notNull(),
		...timestamps,
	},
	(table) => [
		uniqueIndex("uq_community_rating").on(table.communityId, table.userId),
		index("idx_community_ratings_community").on(table.communityId),
	],
);

export const communityRatingsRelations = relations(communityRatings, ({ one }) => ({
	community: one(communities, {
		fields: [communityRatings.communityId],
		references: [communities.id],
	}),
	user: one(users, {
		fields: [communityRatings.userId],
		references: [users.id],
	}),
}));

export type CommunityRating = typeof communityRatings.$inferSelect;
export type NewCommunityRating = typeof communityRatings.$inferInsert;
