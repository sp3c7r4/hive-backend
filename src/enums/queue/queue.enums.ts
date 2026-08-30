export enum QueueNames {
	EMAIL = "hive-email-queue",
	RECEIPT = "hive-receipt",
	SUBSCRIPTION_EXPIRY = "hive-subscription-expiry-queue",
}

export enum JobNames {
	SEND_EMAIL = "send-email-job",
}

export enum EmailJobNames {
	WELCOME = "welcome",
	RESET_PASSWORD = "reset-password",
	VERIFY_EMAIL = "verify-email",
	VERIFY_OTP = "verify-otp",
	CHILD_LINKED = "child-linked",
	ENROLLMENT_CONFIRMED = "enrollment-confirmed",
	CERTIFICATE_ISSUED = "certificate-issued",
	COMMUNITY_INVITE = "community-invite",
	ASSIGNMENT_GRADED = "assignment-graded",
}
