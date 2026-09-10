-- Payout account (spec: withdrawal redesign, patch 3).
--
-- users: the instructor's last VERIFIED payout destination. One account per
-- user (last wins); the server re-resolves the name via Paystack on save, so
-- a client can never store an invented account name. Nullable: not every
-- instructor withdraws.
ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_bank_name varchar(255);
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_bank_code varchar(20);
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_account_number varchar(20);
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_account_name varchar(255);
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_account_verified_at timestamp;
--> statement-breakpoint
-- withdrawals: snapshot of the Paystack bank CODE used at request time, so a
-- payout never depends on resolving a bank name again (legacy rows keep NULL
-- and fall back to name resolution at approve time).
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS bank_code varchar(20);
