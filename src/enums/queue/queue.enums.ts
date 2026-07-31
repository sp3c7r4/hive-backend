export enum QueueNames {
	EMAIL = "email-queue",
	NOTIFICATION = "notification-queue",
	RECEIPT = "receipt",
	SUBSCRIPTION_EXPIRY = "subscription-expiry-queue",
}

export enum JobNames {
	SEND_EMAIL = "send-email-job",
	SEND_NOTIFICATION = "send-notification-job",
}

export enum EmailJobNames {
	WELCOME = "welcome",
	RESET_PASSWORD = "reset-password",
	VERIFY_EMAIL = "verify-email",
	VERIFY_OTP = "verify-otp",
	VERIFY_PHONE = "verify-phone",
	VERIFY_SMS = "verify-sms",
	BUSINESS_CREATED = "business-created",
	TRIAL_EXPIRED = "trial-expired",
	CREDITS_EXHAUSTED = "credits-exhausted",
}

export enum WhatsappQueueNames {
	CONNECTION = "whatsapp-connection-queue",
	MESSAGES = "whatsapp-messages-queue",
}

export enum WhatsappJobNames {
	CONNECT = "whatsapp:connect",
	SEND_MESSAGE = "whatsapp:send-message",
	DISCONNECT = "whatsapp:disconnect",
}

export enum TelegramQueueNames {
	CONNECTION = "telegram-connection-queue",
	MESSAGES = "telegram-messages-queue",
}

export enum TelegramJobNames {
	CONNECT = "telegram:connect",
	SEND_MESSAGE = "telegram:send-message",
	DISCONNECT = "telegram:disconnect",
}

export enum WebQueueNames {
	MESSAGES = "web-messages-queue",
}

export enum WebJobNames {
	SEND_MESSAGE = "web:send-message",
	UPDATE_MESSAGE = "web:update-message",
	DELETE_MESSAGE = "web:delete-message",
}
