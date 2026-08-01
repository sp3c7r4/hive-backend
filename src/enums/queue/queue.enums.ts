export enum QueueNames {
	EMAIL = "email-queue",
	RECEIPT = "receipt",
	SUBSCRIPTION_EXPIRY = "subscription-expiry-queue",
}

export enum JobNames {
	SEND_EMAIL = "send-email-job",
}

export enum EmailJobNames {
	WELCOME = "welcome",
	RESET_PASSWORD = "reset-password",
	VERIFY_EMAIL = "verify-email",
	VERIFY_OTP = "verify-otp",
}
