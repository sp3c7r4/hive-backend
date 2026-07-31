export enum WhatsappSubscriberNames {
	CONNECTION = "wconnection",
	MESSAGES = "wmessages",
}

export enum WhatsappNotifications {
	CONNECTED = "connected",
	DISCONNECTED = "disconnected",
	RECONNECTING = "reconnecting",
	MESSAGE_RECEIVED = "message_received",
	PAIRING_QR = "pairing_qr",
	PAIRING_CODE = "pairing_code",
}

export enum TelegramSubscriberNames {
	CONNECTION = "tconnection",
	MESSAGES = "tmessages",
}

export enum TelegramNotifications {
	CONNECTED = "connected",
	DISCONNECTED = "disconnected",
	MESSAGE_RECEIVED = "message_received",
	QR_CODE = "qr_code",
	CODE_REQUIRED = "code_required",
	PASSWORD_REQUIRED = "password_required",
	AUTH_ERROR = "auth_error",
}
