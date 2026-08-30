export enum PaymentTransactionStatus {
	SUCCESS = "success",
	FAILED = "failed",
	PENDING = "pending",
	REFUNDED = "refunded",
}

export enum PaymentTransactionType {
	ENROLLMENT = "enrollment",
	SUBSCRIPTION = "subscription",
	WITHDRAWAL = "withdrawal",
}

export enum PaymentTransactionMethod {
	PAYSTACK = "paystack",
	FLUTTERWAVE = "flutterwave",
	BANK_TRANSFER = "bank_transfer",
}

export enum WithdrawalStatus {
	PENDING = "pending",
	PROCESSING = "processing",
	COMPLETED = "completed",
	FAILED = "failed",
	REJECTED = "rejected",
}

/** @info - Instructor ledger (M1): append-only transaction types */
export enum LedgerTransactionType {
	CREDIT = "credit",
	DEBIT = "debit",
}

/** @info - Instructor ledger categories (source of each row) */
export enum LedgerTransactionCategory {
	ENROLLMENT = "enrollment",
	COMMUNITY = "community",
	WITHDRAWAL = "withdrawal",
	WITHDRAWAL_REFUND = "withdrawal_refund",
}
