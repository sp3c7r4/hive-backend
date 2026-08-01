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
}
