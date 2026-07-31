import type { Document, Types } from "mongoose";
import type { ConnectionPlatform, ConnectionStatus } from "@/enums";

export interface IConnection<T> extends Document<Types.ObjectId> {
	businessId: Types.ObjectId;
	platform: ConnectionPlatform;
	name: string;
	description: string;
	identifier: string; // phone number, IG username, telegram bot token
	status: ConnectionStatus;
	connectedAt: Date;
	lastHeartbeat?: Date;
	metadata?: T; // platform-specific data
}

type PairingMethod = "qr" | "phone";

export interface ConnectionOptions {
	businessId: number;
	connectionId: number;
	phoneNumber: string;
	pairingMethod: PairingMethod;
	action?: "connect" | "reconnect";
	onQR?: (qr: string) => void;
	onPairingCode?: (code: string) => void;
	onConnected?: () => void;
	onReconnecting?: () => void;
	onDisconnected?: () => void;
	onMessage: (message: IncomingMessage) => void;
}

export interface IncomingMessage {
	contactBusinessId: number;
	connectionId: number;
	businessId: number;
	contactId: number;
	isNew?: boolean;
	from: string;
	text: string;
	pushName: string | null;
	messageId: string;
	timestamp: number;
	isGroup: boolean;
	raw: any;
}

export interface WhatsappMetadata {
	type: "whatsapp"; // ← discriminant
	pairingMethod: string;
	phoneNumber: string;
}
export interface TelegramMetadata {
	type: "telegram";
	phoneNumber: string;
}
export interface InstagramMetadata {
	type: "instagram";
	username: string;
}
export interface WebMetadata {
	type: "web";
	url: string;
}

export type ConnectionMetadata =
	| WhatsappMetadata
	| TelegramMetadata
	| InstagramMetadata
	| WebMetadata;
