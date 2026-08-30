-- @info - M1 instructor ledger: balances + append-only transactions + rejected status
CREATE TYPE "instructor_tx_type" AS ENUM('credit', 'debit');--> statement-breakpoint
CREATE TYPE "instructor_tx_category" AS ENUM('enrollment', 'community', 'withdrawal', 'withdrawal_refund');--> statement-breakpoint
CREATE TABLE "instructor_balances" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"instructor_id" integer NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
	"available" integer DEFAULT 0 NOT NULL,
	"withdrawn" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_instructor_balance" ON "instructor_balances" ("instructor_id");--> statement-breakpoint
CREATE INDEX "idx_instructor_balances_instructor" ON "instructor_balances" ("instructor_id");--> statement-breakpoint
CREATE TABLE "instructor_transactions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"instructor_id" integer NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
	"type" "instructor_tx_type" NOT NULL,
	"category" "instructor_tx_category" NOT NULL,
	"amount" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"reference" varchar(255) NOT NULL,
	"payment_id" integer REFERENCES "payments"("id") ON DELETE SET NULL,
	"withdrawal_id" integer REFERENCES "withdrawals"("id") ON DELETE SET NULL,
	"description" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_instructor_tx_ref_category" ON "instructor_transactions" ("reference", "category");--> statement-breakpoint
CREATE INDEX "idx_instructor_tx_instructor" ON "instructor_transactions" ("instructor_id");--> statement-breakpoint
ALTER TYPE "withdrawal_status" ADD VALUE IF NOT EXISTS 'rejected';
