import {
	boolean,
	integer,
	jsonb,
	pgTable,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { TableNames } from "@/enums";
import { timestamps } from "@/models/timestamps.b.model";
import { users } from "@/modules/user/user.model";
import { communities } from "@/modules/communities/community.model";
import { courses } from "@/modules/courses/course.model";
import { instructorReplies } from "@/modules/reviews/review.model";
import { withdrawals } from "@/modules/payment/payment.model";

/** @info - Instructor-specific profile. Core identity lives in users table. */
export const instructorProfiles = pgTable(
	TableNames.INSTRUCTOR_PROFILES,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		specializationTags: jsonb("specialization_tags").$type<string[]>().default([]),
		isAdmin: boolean("is_admin").default(false),
		...timestamps,
	},
);

export type InstructorProfile = typeof instructorProfiles.$inferSelect;
export type NewInstructorProfile = typeof instructorProfiles.$inferInsert;

/** @info - Relations */
export const instructorProfilesRelations = relations(instructorProfiles, ({ one, many }) => ({
	user: one(users, {
		fields: [instructorProfiles.userId],
		references: [users.id],
	}),
	communities: many(communities),
	courses: many(courses),
	replies: many(instructorReplies),
	withdrawals: many(withdrawals),
}));
