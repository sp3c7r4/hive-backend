ALTER TYPE "public"."message_type" ADD VALUE 'system';--> statement-breakpoint
ALTER TYPE "public"."withdrawal_status" ADD VALUE 'rejected';--> statement-breakpoint
CREATE TABLE "instructor_balances" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "instructor_balances_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"instructor_id" integer NOT NULL,
	"available" integer DEFAULT 0 NOT NULL,
	"withdrawn" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instructor_transactions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "instructor_transactions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"instructor_id" integer NOT NULL,
	"type" "instructor_tx_type" NOT NULL,
	"category" "instructor_tx_category" NOT NULL,
	"amount" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"reference" varchar(255) NOT NULL,
	"payment_id" integer,
	"withdrawal_id" integer,
	"description" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "randomize_questions" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD COLUMN "last_read_at" timestamp;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "community_id" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "course_id" integer;--> statement-breakpoint
ALTER TABLE "instructor_balances" ADD CONSTRAINT "instructor_balances_instructor_id_users_id_fk" FOREIGN KEY ("instructor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instructor_transactions" ADD CONSTRAINT "instructor_transactions_instructor_id_users_id_fk" FOREIGN KEY ("instructor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instructor_transactions" ADD CONSTRAINT "instructor_transactions_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instructor_transactions" ADD CONSTRAINT "instructor_transactions_withdrawal_id_withdrawals_id_fk" FOREIGN KEY ("withdrawal_id") REFERENCES "public"."withdrawals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_instructor_balance" ON "instructor_balances" USING btree ("instructor_id");--> statement-breakpoint
CREATE INDEX "idx_instructor_balances_instructor" ON "instructor_balances" USING btree ("instructor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_instructor_tx_ref_category" ON "instructor_transactions" USING btree ("reference","category");--> statement-breakpoint
CREATE INDEX "idx_instructor_tx_instructor" ON "instructor_transactions" USING btree ("instructor_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_conversations_community" ON "conversations" USING btree ("community_id");--> statement-breakpoint
CREATE INDEX "idx_payments_course" ON "payments" USING btree ("course_id");