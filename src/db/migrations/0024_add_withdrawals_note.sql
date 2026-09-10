-- Non-prod payout kill switch (WITHDRAWALS_TRANSFER_ENABLED=false):
-- the withdrawal still advances through the normal status machine, but no
-- Paystack recipient/transfer is created. This column records why the row
-- moved without money leaving the platform balance.
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS note varchar(255);
