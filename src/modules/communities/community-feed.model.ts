import {
	boolean,
	index,
	integer,
	pgTable,
	text,
	uniqueIndex,
	varchar,
	type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { users } from "@/modules/user/user.model";
import { communities } from "@/modules/communities/community.model";
import { TableNames } from "@/enums";
import { softDelete } from "@/models/soft-delete.model";
import { timestamps } from "@/models/timestamps.b.model";

/** @info - Feed posts within a community. Supports pinning, announcements, and soft-delete. */
export const communityPosts = pgTable(
	TableNames.COMMUNITY_POSTS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		communityId: integer("community_id")
			.notNull()
			.references(() => communities.id, { onDelete: "cascade" }),
		authorId: integer("author_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		content: text("content").notNull(),
		isPinned: boolean("is_pinned").default(false),
		isAnnouncement: boolean("is_announcement").default(false),
		likeCount: integer("like_count").default(0),
		commentCount: integer("comment_count").default(0),
		...timestamps,
		...softDelete,
	},
	(table) => [
		index("idx_community_posts_community").on(table.communityId),
		index("idx_community_posts_author").on(table.authorId),
		index("idx_community_posts_pinned").on(table.isPinned),
	],
);

/** @info - File attachments linked to a feed post (images, documents, etc.) */
export const communityPostAttachments = pgTable(
	TableNames.COMMUNITY_POST_ATTACHMENTS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		postId: integer("post_id")
			.notNull()
			.references(() => communityPosts.id, { onDelete: "cascade" }),
		filename: varchar("filename", { length: 500 }).notNull(),
		s3Key: varchar("s3_key", { length: 1000 }).notNull(),
		...timestamps,
	},
	(table) => [
		index("idx_post_attachments_post").on(table.postId),
	],
);

/** @info - Like records for feed posts. Unique per user per post (toggle). */
export const communityPostLikes = pgTable(
	TableNames.COMMUNITY_POST_LIKES,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		postId: integer("post_id")
			.notNull()
			.references(() => communityPosts.id, { onDelete: "cascade" }),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("uq_post_like").on(table.postId, table.userId),
		index("idx_post_likes_post").on(table.postId),
		index("idx_post_likes_user").on(table.userId),
	],
);

/** @info - Comments on feed posts. Supports nesting via parentId (self-referencing). */
export const communityPostComments = pgTable(
	TableNames.COMMUNITY_POST_COMMENTS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		postId: integer("post_id")
			.notNull()
			.references(() => communityPosts.id, { onDelete: "cascade" }),
		authorId: integer("author_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		parentId: integer("parent_id").references(
			(): AnyPgColumn => communityPostComments.id,
			{ onDelete: "set null" },
		),
		content: text("content").notNull(),
		isInstructorReply: boolean("is_instructor_reply").default(false),
		...timestamps,
		...softDelete,
	},
	(table) => [
		index("idx_post_comments_post").on(table.postId),
		index("idx_post_comments_author").on(table.authorId),
		index("idx_post_comments_parent").on(table.parentId),
	],
);

export type CommunityPost = typeof communityPosts.$inferSelect;
export type NewCommunityPost = typeof communityPosts.$inferInsert;
export type CommunityPostAttachment = typeof communityPostAttachments.$inferSelect;
export type NewCommunityPostAttachment = typeof communityPostAttachments.$inferInsert;
export type CommunityPostLike = typeof communityPostLikes.$inferSelect;
export type NewCommunityPostLike = typeof communityPostLikes.$inferInsert;
export type CommunityPostComment = typeof communityPostComments.$inferSelect;
export type NewCommunityPostComment = typeof communityPostComments.$inferInsert;

/** @info - Relations */
export const communityPostsRelations = relations(communityPosts, ({ one, many }) => ({
	community: one(communities, {
		fields: [communityPosts.communityId],
		references: [communities.id],
	}),
	author: one(users, {
		fields: [communityPosts.authorId],
		references: [users.id],
	}),
	attachments: many(communityPostAttachments),
	likes: many(communityPostLikes),
	comments: many(communityPostComments),
}));

export const communityPostAttachmentsRelations = relations(communityPostAttachments, ({ one }) => ({
	post: one(communityPosts, {
		fields: [communityPostAttachments.postId],
		references: [communityPosts.id],
	}),
}));

export const communityPostLikesRelations = relations(communityPostLikes, ({ one }) => ({
	post: one(communityPosts, {
		fields: [communityPostLikes.postId],
		references: [communityPosts.id],
	}),
	user: one(users, {
		fields: [communityPostLikes.userId],
		references: [users.id],
	}),
}));

export const communityPostCommentsRelations = relations(communityPostComments, ({ one, many }) => ({
	post: one(communityPosts, {
		fields: [communityPostComments.postId],
		references: [communityPosts.id],
	}),
	author: one(users, {
		fields: [communityPostComments.authorId],
		references: [users.id],
	}),
	parent: one(communityPostComments, {
		fields: [communityPostComments.parentId],
		references: [communityPostComments.id],
		relationName: "comment_replies",
	}),
	replies: many(communityPostComments, {
		relationName: "comment_replies",
	}),
}));
