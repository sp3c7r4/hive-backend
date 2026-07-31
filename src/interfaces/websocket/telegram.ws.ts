/** @info - Client → Server WebSocket messages */
export type TelegramWsClientMessage =
	| {
			type: "INIT";
			businessId: number;
			name: string;
			description: string;
			identifier: string;
			metadata: { phoneNumber: string; pairingMethod: "qr" | "phone" };
	  }
	| { type: "OTP_CODE"; code: string }
	| { type: "2FA_PASSWORD"; password: string }
	| { type: "RECONNECT"; channelId: number }
	| { type: "DISCONNECT" };

/** @info - Server → Client WebSocket messages */
export type TelegramWsServerMessage =
	| { type: "PENDING"; message: string }
	| { type: "QR_CODE"; qrUrl: string; expires: number }
	| { type: "CODE_REQUIRED"; message: string }
	| { type: "PASSWORD_REQUIRED"; message: string }
	| { type: "CONNECTED"; connectionId: number }
	| { type: "DISCONNECTED"; reason: string }
	| { type: "ERROR"; message: string };
