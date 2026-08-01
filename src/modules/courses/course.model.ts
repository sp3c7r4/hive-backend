import {
	boolean,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { instructors } from "@/modules/instructor/instructor.model";
import { communities } from "@/modules/communities/community.model";
import { enrollments } from "@/modules/enrollments/enrollment.model";
import { certificates } from "@/modules/certificates/certificate.model";
import { reviews } from "@/modules/reviews/review.model";
import { quizQuestions, quizAttempts, assignmentSubmissions } from "@/modules/assessments/assessment.model";
import { lessonProgress } from "@/modules/enrollments/enrollment.model";
import {
	CourseDifficulty,
	CourseVisibility,
	CourseStatus,
	LessonType,
	LessonStatus,
	TableNames,
} from "@/enums";
import { softDelete } from "@/models/soft-delete.model";
import { timestamps } from "@/models/timestamps.b.model";

const courseDifficultyEnum = pgEnum("course_difficulty", Object.values(CourseDifficulty) as [string, ...string[]]);
const courseVisibilityEnum = pgEnum("course_visibility", Object.values(CourseVisibility) as [string, ...string[]]);
const courseStatusEnum = pgEnum("course_status", Object.values(CourseStatus) as [string, ...string[]]);
const lessonTypeEnum = pgEnum("lesson_type", Object.values(LessonType) as [string, ...string[]]);
const lessonStatusEnum = pgEnum("lesson_status", Object.values(LessonStatus) as [string, ...string[]]);

/** @info - A course belongs to one community and is owned by one instructor */
export const courses = pgTable(
	TableNames.COURSES,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		instructorId: integer("instructor_id")
			.notNull()
			.references(() => instructors.id, { onDelete: "restrict" }),
		communityId: integer("community_id")
			.notNull()
			.references(() => communities.id, { onDelete: "restrict" }),
		title: varchar("title", { length: 255 }).notNull(),
		slug: varchar("slug", { length: 255 }).notNull(),
		subtitle: varchar("subtitle", { length: 500 }),
		description: text("description"),
		category: varchar("category", { length: 255 }),
		difficulty: courseDifficultyEnum("difficulty").default("beginner").notNull(),
		visibility: courseVisibilityEnum("visibility").default("public").notNull(),
		/** @info - Price in kobo, 0 = free */
		price: integer("price").default(0).notNull(),
		isFree: boolean("is_free").default(true),
		/** @info - Monthly subscription price in kobo */
		monthlyPrice: integer("monthly_price"),
		coverImageUrl: varchar("cover_image_url", { length: 500 }),
		sequentialAccess: boolean("sequential_access").default(false),
		dripContent: boolean("drip_content").default(false),
		allowComments: boolean("allow_comments").default(true),
		allowDownloads: boolean("allow_downloads").default(true),
		offerCertificate: boolean("offer_certificate").default(false),
		minCompletionPercent: integer("min_completion_percent").default(80),
		minQuizScorePercent: integer("min_quiz_score_percent").default(70),
		minAttendancePercent: integer("min_attendance_percent").default(60),
		status: courseStatusEnum("status").default("draft").notNull(),
		enrollmentCount: integer("enrollment_count").default(0),
		/** @info - Stored as 0–50, divide by 10 for display */
		averageRating: integer("average_rating").default(0),
		reviewCount: integer("review_count").default(0),
		...timestamps,
		...softDelete,
	},
	(table) => [
		uniqueIndex("uq_courses_slug").on(table.slug),
		index("idx_courses_instructor").on(table.instructorId),
		index("idx_courses_community").on(table.communityId),
		index("idx_courses_status").on(table.status),
		index("idx_courses_category").on(table.category),
	],
);

/** @info - Ordered container for lessons within a course */
export const modules = pgTable(
	TableNames.MODULES,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		courseId: integer("course_id")
			.notNull()
			.references(() => courses.id, { onDelete: "cascade" }),
		title: varchar("title", { length: 255 }).notNull(),
		description: text("description"),
		sortOrder: integer("sort_order").default(0).notNull(),
		...timestamps,
	},
	(table) => [
		index("idx_modules_course").on(table.courseId),
	],
);

/** @info - Individual lesson within a module — video, PDF, live, quiz, or assignment */
export const lessons = pgTable(
	TableNames.LESSONS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		moduleId: integer("module_id")
			.notNull()
			.references(() => modules.id, { onDelete: "cascade" }),
		title: varchar("title", { length: 255 }).notNull(),
		description: text("description"),
		type: lessonTypeEnum("type").default("video").notNull(),
		/** @info - Human-readable duration e.g. "12:30" */
		duration: varchar("duration", { length: 100 }),
		sortOrder: integer("sort_order").default(0).notNull(),
		freePreview: boolean("free_preview").default(false),
		status: lessonStatusEnum("status").default("draft").notNull(),
		videoUrl: varchar("video_url", { length: 1000 }),
		pdfUrl: varchar("pdf_url", { length: 1000 }),
		liveMeetingLink: varchar("live_meeting_link", { length: 1000 }),
		liveMeetingDate: varchar("live_meeting_date", { length: 255 }),
		attachmentUrl: varchar("attachment_url", { length: 1000 }),
		/** @info - JSONB for lesson-type-specific config (assignment settings, quiz config, etc.) */
		settings: jsonb("settings"),
		...timestamps,
	},
	(table) => [
		index("idx_lessons_module").on(table.moduleId),
		index("idx_lessons_type").on(table.type),
		index("idx_lessons_status").on(table.status),
	],
);

export type Course = typeof courses.$inferSelect;
export type NewCourse = typeof courses.$inferInsert;
export type Module = typeof modules.$inferSelect;
export type NewModule = typeof modules.$inferInsert;
export type Lesson = typeof lessons.$inferSelect;
export type NewLesson = typeof lessons.$inferInsert;

/** @info - Relations */
export const coursesRelations = relations(courses, ({ one, many }) => ({
	instructor: one(instructors, {
		fields: [courses.instructorId],
		references: [instructors.id],
	}),
	community: one(communities, {
		fields: [courses.communityId],
		references: [communities.id],
	}),
	modules: many(modules),
	enrollments: many(enrollments),
	certificates: many(certificates),
	reviews: many(reviews),
}));

export const modulesRelations = relations(modules, ({ one, many }) => ({
	course: one(courses, {
		fields: [modules.courseId],
		references: [courses.id],
	}),
	lessons: many(lessons),
}));

export const lessonsRelations = relations(lessons, ({ one, many }) => ({
	module: one(modules, {
		fields: [lessons.moduleId],
		references: [modules.id],
	}),
	quizQuestions: many(quizQuestions),
	quizAttempts: many(quizAttempts),
	assignmentSubmissions: many(assignmentSubmissions),
	lessonProgress: many(lessonProgress),
}));
