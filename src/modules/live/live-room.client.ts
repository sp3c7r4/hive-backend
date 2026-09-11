import { RoomServiceClient } from "livekit-server-sdk";
import { config } from "@/config";

/**
 * @info - LiveKit's server API: participant listing and in-room moderation. It lives in
 * its own module so tests can stand in a mock without stubbing the token signer, and
 * so the whole server-side surface of a live session is one import.
 *
 * `config.livekit.url` is the API URL (ws:// or wss://); RoomServiceClient talks
 * http(s) to the same host. `publicUrl` is the browser-facing one and is deliberately
 * not used here - pointing this at the browser URL would break silently on staging,
 * where the two differ.
 */
const httpHost = (url: string): string => url.replace(/^ws/, "http");

let client: RoomServiceClient | null = null;

export const getRoomServiceClient = (): RoomServiceClient => {
	if (!client) {
		client = new RoomServiceClient(
			httpHost(config.livekit.url),
			config.livekit.apiKey,
			config.livekit.apiSecret,
		);
	}
	return client;
};
