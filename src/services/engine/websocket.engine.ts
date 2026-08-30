import { serviceLogger } from "@/utils";

/** @info - Minimal socket surface both the engine and Hono's WSContext satisfy. */
type SocketLike = {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	readyState: number;
};

/**
 * @class WebsocketEngine
 * @description In-memory connection registry for the HTTP process. Maps a
 *              userId to every live socket on this server instance. PM2 runs
 *              the API in fork mode (2 instances), so each process has its own
 *              registry and only forwards Redis pub/sub traffic to its own
 *              sockets — no sticky sessions needed.
 */
export class WebsocketEngine {
	private static instance: WebsocketEngine;

	static getInstance(): WebsocketEngine {
		if (!this.instance) this.instance = new WebsocketEngine();
		return this.instance;
	}

	private readonly connections = new Map<number, Set<SocketLike>>();
	private readonly log = serviceLogger("WsEngine");

	private constructor() {}

	add = (userId: number, ws: SocketLike) => {
		const set = this.connections.get(userId) ?? new Set<SocketLike>();
		set.add(ws);
		this.connections.set(userId, set);
	};

	remove = (userId: number, ws: SocketLike) => {
		const set = this.connections.get(userId);
		if (!set) return;
		set.delete(ws);
		if (set.size === 0) this.connections.delete(userId);
	};

	has = (userId: number) => (this.connections.get(userId)?.size ?? 0) > 0;

	/** Send a JSON envelope to every socket of a user on this process. */
	send = (userId: number, payload: unknown) => {
		const set = this.connections.get(userId);
		if (!set) return false;
		const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
		for (const ws of set) {
			try {
				if (ws.readyState === 1) ws.send(raw);
			} catch (err) {
				this.log.warn(`Failed to send to user ${userId}: ${(err as Error).message}`);
			}
		}
		return true;
	};

	/** Ping support for unit tests / diagnostics. */
	onlineCount = (userId: number) => this.connections.get(userId)?.size ?? 0;
}
