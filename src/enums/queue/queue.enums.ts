export enum QueueNames {
	EMAIL = "hive-email-queue",
	RECEIPT = "hive-receipt",
	SUBSCRIPTION_EXPIRY = "hive-subscription-expiry-queue",
	CERTIFICATE = "hive-certificate",
	LESSON_CHUNK = "hive-lesson-chunk",
	GRADING = "hive-grading",
}

export enum JobNames {
	SEND_EMAIL = "send-email-job",
	GENERATE_CERTIFICATE = "generate-certificate-job",
	EMBED_LESSON = "embed-lesson-job",
	GRADE_SUBMISSION = "grade-submission-job",
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
	MEMBERSHIP_APPROVED = "membership-approved",
	ASSIGNMENT_GRADED = "assignment-graded",
}
