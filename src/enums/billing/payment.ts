export enum PaymentServiceProvider {
	PAYSTACK = "paystack",
}

export enum PaymentStatus {
	SUCCESS = "success",
	FAILED = "failed",
	CANCELLED = "cancelled",
	ABANDONED = "abandoned",
	REFUNDED = "refunded",
	PENDING = "pending",
}

export enum PaymentCurrency {
	NGN = "ngn",
	USD = "usd",
}

export enum PaymentChannel {
	CARD = "card",
	BANK = "bank",
	USSD = "ussd",
	BANK_TRANSFER = "bank_transfer",
}
