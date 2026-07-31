export enum BotHandoffSensitivity {
	LOW = "low",
	MEDIUM = "medium",
	HIGH = "high",
}

export enum BotFallBackMessages {
	BOT_NOT_AVAILABLE = "I'm sorry, but I'm not available right now. Please try again later.",
	CHANNEL_UNMONITORED = "This channel is currently unmonitored. Please try again later.",
}

export enum BotWebTheme {
	LIGHT = "light",
	DARK = "dark",
	AUTO = "auto",
}

export enum BotWsEventTypes {
	SEND = "SEND_MESSAGE",
	UPDATE = "UPDATE_MESSAGE",
	DELETE = "DELETE_MESSAGE",
}
