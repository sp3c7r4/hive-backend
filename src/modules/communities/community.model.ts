import {
	boolean,
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
import { instructors } from "@/modules/instructor/instructor.model";
import { courses } from "@/modules/courses/course.model";
import { payments } from "@/modules/payment/payment.model";
import {
	CommunityVisibility,
	CommunityMemberRole,
	CommunityMemberStatus,
	CommunityInviteStatus,
	UserRole,
	TableNames,
} from "@/enums";
import { softDelete } from "@/models/soft-delete.model";
import { timestamps } from "@/models/timestamps.b.model";

const communityVisibilityEnum = pgEnum("community_visibility", Object.values(CommunityVisibility) as [string, ...string[]]);
const communityMemberRoleEnum = pgEnum("community_member_role", Object.values(CommunityMemberRole) as [string, ...string[]]);
const communityMemberStatusEnum = pgEnum("community_member_status", Object.values(CommunityMemberStatus) as [string, ...string[]]);
const communityInviteStatusEnum = pgEnum("community_invite_status", Object.values(CommunityInviteStatus) as [string, ...string[]]);
const userRoleEnum = pgEnum("user_role", Object.values(UserRole) as [string, ...string[]]);

/** @info - Top-level container for courses and social interaction, owned by an instructor */
export const communities = pgTable(
	TableNames.COMMUNITIES,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		ownerId: integer("owner_id")
			.notNull()
			.references(() => instructors.id, { onDelete: "restrict" }),
		name: varchar("name", { length: 255 }).notNull(),
		slug: varchar("slug", { length: 255 }).notNull(),
		description: text("description"),
		category: varchar("category", { length: 255 }),
		visibility: communityVisibilityEnum("visibility").default("public").notNull(),
		requiresApproval: boolean("requires_approval").default(false),
		isPaid: boolean("is_paid").default(false),
		/** @info - Price in kobo, null if free */
		price: integer("price"),
		coverImageUrl: varchar("cover_image_url", { length: 500 }),
		memberCount: integer("member_count").default(0),
		courseCount: integer("course_count").default(0),
		/** @info - Stored as 0–50, divide by 10 for display */
		averageRating: integer("average_rating").default(0),
		reviewCount: integer("review_count").default(0),
		sequentialCourses: boolean("sequential_courses").default(false),
		allowDownloads: boolean("allow_downloads").default(true),
		maxConcurrentDevices: integer("max_concurrent_devices").default(3),
		gracePeriodDays: integer("grace_period_days").default(0),
		...timestamps,
		...softDelete,
	},
	(table) => [
		uniqueIndex("uq_communities_slug").on(table.slug),
		index("idx_communities_owner").on(table.ownerId),
		index("idx_communities_category").on(table.category),
		index("idx_communities_visibility").on(table.visibility),
	],
);

/** @info - Polymorphic membership — entityId + entityType references the role table */
export const communityMembers = pgTable(
	TableNames.COMMUNITY_MEMBERS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		communityId: integer("community_id")
			.notNull()
			.references(() => communities.id, { onDelete: "cascade" }),
		/** @info - ID of the member in their role table (instructors / students / parents) */
		entityId: integer("entity_id").notNull(),
		/** @info - Which role table entityId refers to */
		entityType: userRoleEnum("entity_type").notNull(),
		role: communityMemberRoleEnum("role").default("member").notNull(),
		status: communityMemberStatusEnum("status").default("active").notNull(),
		joinedAt: timestamp("joined_at").defaultNow().notNull(),
		expiresAt: timestamp("expires_at"),
		...timestamps,
	},
	(table) => [
		uniqueIndex("uq_community_member").on(table.communityId, table.entityId, table.entityType),
		index("idx_community_members_community").on(table.communityId),
		index("idx_community_members_entity").on(table.entityId, table.entityType),
		index("idx_community_members_status").on(table.status),
	],
);

/** @info - Tracks email invitations sent by community admins */
export const communityInvites = pgTable(
	TableNames.COMMUNITY_INVITES,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		communityId: integer("community_id")
			.notNull()
			.references(() => communities.id, { onDelete: "cascade" }),
		/** @info - ID of the inviter in their role table */
		invitedBy: integer("invited_by").notNull(),
		email: varchar("email", { length: 255 }).notNull(),
		status: communityInviteStatusEnum("status").default("pending").notNull(),
		sentAt: timestamp("sent_at").defaultNow().notNull(),
		acceptedAt: timestamp("accepted_at"),
		...timestamps,
	},
	(table) => [
		uniqueIndex("uq_community_invite").on(table.communityId, table.email),
		index("idx_community_invites_community").on(table.communityId),
		index("idx_community_invites_status").on(table.status),
	],
);

export type Community = typeof communities.$inferSelect;
export type NewCommunity = typeof communities.$inferInsert;
export type CommunityMember = typeof communityMembers.$inferSelect;
export type NewCommunityMember = typeof communityMembers.$inferInsert;
export type CommunityInvite = typeof communityInvites.$inferSelect;
export type NewCommunityInvite = typeof communityInvites.$inferInsert;

/** @info - Relations */
export const communitiesRelations = relations(communities, ({ one, many }) => ({
	owner: one(instructors, {
		fields: [communities.ownerId],
		references: [instructors.id],
	}),
	members: many(communityMembers),
	invites: many(communityInvites),
	courses: many(courses),
	payments: many(payments),
}));

export const communityMembersRelations = relations(communityMembers, ({ one }) => ({
	community: one(communities, {
		fields: [communityMembers.communityId],
		references: [communities.id],
	}),
}));

export const communityInvitesRelations = relations(communityInvites, ({ one }) => ({
	community: one(communities, {
		fields: [communityInvites.communityId],
		references: [communities.id],
	}),
}));
