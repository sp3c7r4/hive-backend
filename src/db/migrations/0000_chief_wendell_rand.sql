CREATE TYPE "public"."user_role" AS ENUM('student', 'instructor', 'parent', 'admin');--> statement-breakpoint
CREATE TYPE "public"."auth_provider" AS ENUM('email', 'google', 'facebook', 'github');--> statement-breakpoint
CREATE TYPE "public"."assignment_submission_status" AS ENUM('pending', 'submitted', 'graded', 'returned');--> statement-breakpoint
CREATE TYPE "public"."quiz_question_type" AS ENUM('multiple', 'truefalse', 'fillblank');--> statement-breakpoint
CREATE TYPE "public"."community_invite_status" AS ENUM('pending', 'accepted', 'expired');--> statement-breakpoint
CREATE TYPE "public"."community_member_role" AS ENUM('owner', 'admin', 'member', 'guest');--> statement-breakpoint
CREATE TYPE "public"."community_member_status" AS ENUM('active', 'blocked', 'pending');--> statement-breakpoint
CREATE TYPE "public"."community_visibility" AS ENUM('public', 'private', 'invite_only');--> statement-breakpoint
CREATE TYPE "public"."course_difficulty" AS ENUM('beginner', 'intermediate', 'advanced');--> statement-breakpoint
CREATE TYPE "public"."course_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."course_visibility" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TYPE "public"."lesson_status" AS ENUM('draft', 'published');--> statement-breakpoint
CREATE TYPE "public"."lesson_type" AS ENUM('video', 'pdf', 'live', 'quiz', 'assignment');--> statement-breakpoint
CREATE TYPE "public"."conversation_type" AS ENUM('direct', 'group');--> statement-breakpoint
CREATE TYPE "public"."message_type" AS ENUM('text', 'image', 'file');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('enrollment', 'payment', 'assignment', 'quiz', 'message', 'system', 'community', 'certificate', 'review');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('paystack', 'flutterwave', 'bank_transfer');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('success', 'failed', 'pending', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."payment_type" AS ENUM('enrollment', 'subscription', 'withdrawal');--> statement-breakpoint
CREATE TYPE "public"."withdrawal_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "user_roles" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "user_roles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"role" "user_role" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_credentials" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "user_credentials_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"role" "user_role" NOT NULL,
	"provider" "auth_provider" NOT NULL,
	"provider_account_id" varchar(255) NOT NULL,
	"tokens" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"first_name" varchar(255) NOT NULL,
	"last_name" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" varchar(255),
	"avatar_url" varchar(500),
	"bio" text,
	"phone" varchar(50),
	"phone_verified" boolean DEFAULT false,
	"email_verified" boolean DEFAULT false,
	"email_verified_at" timestamp,
	"last_login_at" timestamp,
	"password_changed_at" timestamp,
	"onboarded" boolean DEFAULT false,
	"preferences" jsonb DEFAULT '{"theme":"system","locale":"en-US","timezone":"UTC","notifications":{"email":true,"push":true,"marketing":false,"digest":"none"}}'::jsonb,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignment_submissions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "assignment_submissions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"lesson_id" integer NOT NULL,
	"text" text,
	"file_urls" jsonb DEFAULT '[]'::jsonb,
	"status" "assignment_submission_status" DEFAULT 'pending' NOT NULL,
	"score" integer,
	"feedback" text,
	"submitted_at" timestamp,
	"graded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quiz_attempts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "quiz_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"lesson_id" integer NOT NULL,
	"question_id" integer NOT NULL,
	"selected_answer" varchar(500),
	"is_correct" boolean DEFAULT false,
	"attempted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quiz_questions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "quiz_questions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"lesson_id" integer NOT NULL,
	"type" "quiz_question_type" DEFAULT 'multiple' NOT NULL,
	"text" text NOT NULL,
	"options" jsonb,
	"correct_answer" varchar(500) NOT NULL,
	"explanation" text,
	"points" integer DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "certificates" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "certificates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"course_id" integer NOT NULL,
	"enrollment_id" integer NOT NULL,
	"code" varchar(100) NOT NULL,
	"issued_at" timestamp DEFAULT now() NOT NULL,
	"completion_percent" integer NOT NULL,
	"quiz_score_percent" integer NOT NULL,
	"attendance_percent" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communities" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "communities_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"owner_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"description" text,
	"category" varchar(255),
	"visibility" "community_visibility" DEFAULT 'public' NOT NULL,
	"requires_approval" boolean DEFAULT false,
	"is_paid" boolean DEFAULT false,
	"price" integer,
	"cover_image_url" varchar(500),
	"member_count" integer DEFAULT 0,
	"course_count" integer DEFAULT 0,
	"average_rating" integer DEFAULT 0,
	"review_count" integer DEFAULT 0,
	"sequential_courses" boolean DEFAULT false,
	"allow_downloads" boolean DEFAULT true,
	"max_concurrent_devices" integer DEFAULT 3,
	"grace_period_days" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "community_invites" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "community_invites_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"community_id" integer NOT NULL,
	"invited_by" integer NOT NULL,
	"email" varchar(255) NOT NULL,
	"status" "community_invite_status" DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp DEFAULT now() NOT NULL,
	"accepted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_members" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "community_members_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"community_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"role" "user_role" NOT NULL,
	"member_role" "community_member_role" DEFAULT 'member' NOT NULL,
	"status" "community_member_status" DEFAULT 'active' NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "courses" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "courses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"instructor_id" integer NOT NULL,
	"community_id" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"subtitle" varchar(500),
	"description" text,
	"category" varchar(255),
	"difficulty" "course_difficulty" DEFAULT 'beginner' NOT NULL,
	"visibility" "course_visibility" DEFAULT 'public' NOT NULL,
	"price" integer DEFAULT 0 NOT NULL,
	"is_free" boolean DEFAULT true,
	"monthly_price" integer,
	"cover_image_url" varchar(500),
	"sequential_access" boolean DEFAULT false,
	"drip_content" boolean DEFAULT false,
	"allow_comments" boolean DEFAULT true,
	"allow_downloads" boolean DEFAULT true,
	"offer_certificate" boolean DEFAULT false,
	"min_completion_percent" integer DEFAULT 80,
	"min_quiz_score_percent" integer DEFAULT 70,
	"min_attendance_percent" integer DEFAULT 60,
	"status" "course_status" DEFAULT 'draft' NOT NULL,
	"enrollment_count" integer DEFAULT 0,
	"average_rating" integer DEFAULT 0,
	"review_count" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "lessons" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "lessons_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"module_id" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"type" "lesson_type" DEFAULT 'video' NOT NULL,
	"duration" varchar(100),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"free_preview" boolean DEFAULT false,
	"status" "lesson_status" DEFAULT 'draft' NOT NULL,
	"video_url" varchar(1000),
	"pdf_url" varchar(1000),
	"live_meeting_link" varchar(1000),
	"live_meeting_date" varchar(255),
	"attachment_url" varchar(1000),
	"settings" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "modules" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "modules_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"course_id" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrollments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "enrollments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"course_id" integer NOT NULL,
	"enrolled_by_id" integer,
	"progress_percent" integer DEFAULT 0,
	"completed_at" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "lesson_progress" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "lesson_progress_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"enrollment_id" integer NOT NULL,
	"lesson_id" integer NOT NULL,
	"completed" boolean DEFAULT false,
	"last_position_seconds" integer DEFAULT 0,
	"completed_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instructor_profiles" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "instructor_profiles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"specialization_tags" jsonb DEFAULT '[]'::jsonb,
	"is_admin" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_participants" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "conversation_participants_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"conversation_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"role" "user_role" NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"left_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "conversations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"type" "conversation_type" DEFAULT 'direct' NOT NULL,
	"title" varchar(255),
	"last_message_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"conversation_id" integer NOT NULL,
	"sender_id" integer NOT NULL,
	"type" "message_type" DEFAULT 'text' NOT NULL,
	"content" text,
	"attachment_url" varchar(1000),
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notifications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"role" "user_role" NOT NULL,
	"type" "notification_type" NOT NULL,
	"title" varchar(255) NOT NULL,
	"message" varchar(1000) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parent_child_links" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "parent_child_links_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"parent_id" integer NOT NULL,
	"student_id" integer NOT NULL,
	"linked_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parent_profiles" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "parent_profiles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"payer_id" integer NOT NULL,
	"payer_role" "user_role" NOT NULL,
	"enrollment_id" integer,
	"community_id" integer,
	"amount" integer NOT NULL,
	"platform_fee" integer DEFAULT 0,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"method" "payment_method" DEFAULT 'paystack' NOT NULL,
	"reference" varchar(255) NOT NULL,
	"type" "payment_type" NOT NULL,
	"description" text,
	"student_id" integer,
	"receipt_url" varchar(1000),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "withdrawals" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "withdrawals_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"instructor_id" integer NOT NULL,
	"amount" integer NOT NULL,
	"bank_name" varchar(255) NOT NULL,
	"account_number" varchar(20) NOT NULL,
	"account_name" varchar(255) NOT NULL,
	"status" "withdrawal_status" DEFAULT 'pending' NOT NULL,
	"reference" varchar(255) NOT NULL,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instructor_replies" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "instructor_replies_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"review_id" integer NOT NULL,
	"instructor_id" integer NOT NULL,
	"comment" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reviews_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"course_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"rating" integer NOT NULL,
	"title" varchar(255),
	"comment" text NOT NULL,
	"helpful_count" integer DEFAULT 0,
	"helpful_by_user_ids" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_profiles" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "student_profiles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"interest_tags" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_credentials" ADD CONSTRAINT "user_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_submissions" ADD CONSTRAINT "assignment_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_submissions" ADD CONSTRAINT "assignment_submissions_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_question_id_quiz_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."quiz_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communities" ADD CONSTRAINT "communities_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_invites" ADD CONSTRAINT "community_invites_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_invites" ADD CONSTRAINT "community_invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_members" ADD CONSTRAINT "community_members_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_members" ADD CONSTRAINT "community_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_instructor_id_users_id_fk" FOREIGN KEY ("instructor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modules" ADD CONSTRAINT "modules_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_enrolled_by_id_users_id_fk" FOREIGN KEY ("enrolled_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instructor_profiles" ADD CONSTRAINT "instructor_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_child_links" ADD CONSTRAINT "parent_child_links_parent_id_users_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_child_links" ADD CONSTRAINT "parent_child_links_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_profiles" ADD CONSTRAINT "parent_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payer_id_users_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_instructor_id_users_id_fk" FOREIGN KEY ("instructor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instructor_replies" ADD CONSTRAINT "instructor_replies_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instructor_replies" ADD CONSTRAINT "instructor_replies_instructor_id_users_id_fk" FOREIGN KEY ("instructor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_role" ON "user_roles" USING btree ("user_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_credential_provider" ON "user_credentials" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE INDEX "idx_user_credentials_user" ON "user_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_users_email" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_assignment_submission" ON "assignment_submissions" USING btree ("user_id","lesson_id");--> statement-breakpoint
CREATE INDEX "idx_assignment_submissions_user" ON "assignment_submissions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_assignment_submissions_lesson" ON "assignment_submissions" USING btree ("lesson_id");--> statement-breakpoint
CREATE INDEX "idx_assignment_submissions_status" ON "assignment_submissions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_quiz_attempts_user" ON "quiz_attempts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_quiz_attempts_lesson" ON "quiz_attempts" USING btree ("lesson_id");--> statement-breakpoint
CREATE INDEX "idx_quiz_attempts_question" ON "quiz_attempts" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "idx_quiz_questions_lesson" ON "quiz_questions" USING btree ("lesson_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_certificates_code" ON "certificates" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_certificate_user_course" ON "certificates" USING btree ("user_id","course_id");--> statement-breakpoint
CREATE INDEX "idx_certificates_user" ON "certificates" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_certificates_course" ON "certificates" USING btree ("course_id");--> statement-breakpoint
CREATE INDEX "idx_certificates_enrollment" ON "certificates" USING btree ("enrollment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_communities_slug" ON "communities" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_communities_owner" ON "communities" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_communities_category" ON "communities" USING btree ("category");--> statement-breakpoint
CREATE INDEX "idx_communities_visibility" ON "communities" USING btree ("visibility");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_community_invite" ON "community_invites" USING btree ("community_id","email");--> statement-breakpoint
CREATE INDEX "idx_community_invites_community" ON "community_invites" USING btree ("community_id");--> statement-breakpoint
CREATE INDEX "idx_community_invites_status" ON "community_invites" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_community_member" ON "community_members" USING btree ("community_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_community_members_community" ON "community_members" USING btree ("community_id");--> statement-breakpoint
CREATE INDEX "idx_community_members_user" ON "community_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_community_members_status" ON "community_members" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_courses_slug" ON "courses" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_courses_instructor" ON "courses" USING btree ("instructor_id");--> statement-breakpoint
CREATE INDEX "idx_courses_community" ON "courses" USING btree ("community_id");--> statement-breakpoint
CREATE INDEX "idx_courses_status" ON "courses" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_courses_category" ON "courses" USING btree ("category");--> statement-breakpoint
CREATE INDEX "idx_lessons_module" ON "lessons" USING btree ("module_id");--> statement-breakpoint
CREATE INDEX "idx_lessons_type" ON "lessons" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_lessons_status" ON "lessons" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_modules_course" ON "modules" USING btree ("course_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_enrollment" ON "enrollments" USING btree ("user_id","course_id");--> statement-breakpoint
CREATE INDEX "idx_enrollments_user" ON "enrollments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_enrollments_course" ON "enrollments" USING btree ("course_id");--> statement-breakpoint
CREATE INDEX "idx_enrollments_enrolled_by" ON "enrollments" USING btree ("enrolled_by_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_lesson_progress" ON "lesson_progress" USING btree ("enrollment_id","lesson_id");--> statement-breakpoint
CREATE INDEX "idx_lesson_progress_enrollment" ON "lesson_progress" USING btree ("enrollment_id");--> statement-breakpoint
CREATE INDEX "idx_lesson_progress_lesson" ON "lesson_progress" USING btree ("lesson_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversation_participant" ON "conversation_participants" USING btree ("conversation_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_conversation_participants_conversation" ON "conversation_participants" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_conversation_participants_user" ON "conversation_participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_type" ON "conversations" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_messages_conversation" ON "messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_messages_sender" ON "messages" USING btree ("sender_id");--> statement-breakpoint
CREATE INDEX "idx_messages_read_at" ON "messages" USING btree ("read_at");--> statement-breakpoint
CREATE INDEX "idx_notifications_user" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_notifications_type" ON "notifications" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_notifications_read_at" ON "notifications" USING btree ("read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_parent_child_link" ON "parent_child_links" USING btree ("parent_id","student_id");--> statement-breakpoint
CREATE INDEX "idx_parent_child_parent" ON "parent_child_links" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_parent_child_student" ON "parent_child_links" USING btree ("student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_payments_reference" ON "payments" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "idx_payments_payer" ON "payments" USING btree ("payer_id");--> statement-breakpoint
CREATE INDEX "idx_payments_enrollment" ON "payments" USING btree ("enrollment_id");--> statement-breakpoint
CREATE INDEX "idx_payments_status" ON "payments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_payments_student" ON "payments" USING btree ("student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_withdrawals_reference" ON "withdrawals" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "idx_withdrawals_instructor" ON "withdrawals" USING btree ("instructor_id");--> statement-breakpoint
CREATE INDEX "idx_withdrawals_status" ON "withdrawals" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_instructor_reply" ON "instructor_replies" USING btree ("review_id");--> statement-breakpoint
CREATE INDEX "idx_instructor_replies_instructor" ON "instructor_replies" USING btree ("instructor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_review" ON "reviews" USING btree ("course_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_reviews_course" ON "reviews" USING btree ("course_id");--> statement-breakpoint
CREATE INDEX "idx_reviews_user" ON "reviews" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_reviews_rating" ON "reviews" USING btree ("rating");