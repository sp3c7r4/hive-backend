import { upgradeWebSocket } from "@hono/node-server";
import { JwtService } from "@/services/jwt.service";
import type { IJwtPayload, IAuthData } from "@/interfaces/auth/auth.interface";
import { CacheService } from "@/services/cache.service";
import { WebsocketEngine } from "@/services/engine/websocket.engine";
import { ChatPubSubService } from "@/services/engine/chat-pubsub.service";
import { MessagingService } from "./messaging.service";
import { MessagingRepository } from "./messaging.repository";
import type { Context } from "hono";

/**
 * @info - WebSocket endpoint: `GET /ws?token=<accessToken>`.
 *
 * Protocol (JSON strings, same envelope as REST):
 *   client → server: { type: "ping" }
 *                    { type: "read", conversationId: number }
 *   server → client: { timestamp, status, success, data: { type, payload } }
 *                    ─ ping → pong
 *                    ─ message:new, message:read, message:deleted, error
 *
 * Auth at handshake (token can't be a header in browsers). Invalid/missing
 * token closes with 4401 before the socket is registered.
 *
 * ⚠️ Registered BEFORE the CORS/RequestLogger middlewares in server.ts —
 * header-modifying middleware breaks the WebSocket upgrade (Hono docs).
 */

const AUTH_FAIL_CODE = 4401;

const out = (type: string, payload: unknown) => ({
	timestamp: new Date().toISOString(),
	status: 200,
	success: true,
	data: { type, payload },
});

const outErr = (message: string, code = "BAD_EVENT") => ({
	timestamp: new Date().toISOString(),
	status: 400,
	success: false,
	error: { code, message },
});

export const messagingWsHandler = upgradeWebSocket((c: Context) => {
	let userId: number | null = null;
	let userName: string | null = null;
	let liveWs: any = null;

	return {
		onOpen: async (_event, ws) => {
			liveWs = ws;
			try {
				const token = c.req.query("token") ?? "";
				const decoded = JwtService.getInstance().verifyToken<IJwtPayload>(token);
				const data = await CacheService.getInstance().get<IAuthData>(decoded.authId);
				if (!data?.id) throw new Error("Session not found");
				userId = data.id;
				userName = [data.firstName, data.lastName].filter(Boolean).join(" ") || data.email || "User";
			} catch {
				ws.close(AUTH_FAIL_CODE, "Unauthorized");
				return;
			}

			const engine = WebsocketEngine.getInstance();
			engine.add(userId!, ws);
			await ChatPubSubService.getInstance().subscribeUser(userId!);
		},

		onMessage: async (event, ws) => {
			if (userId === null) {
				ws.close(AUTH_FAIL_CODE, "Unauthorized");
				return;
			}

			let parsed: any;
			try {
				parsed = JSON.parse(String(event.data));
			} catch {
				ws.send(JSON.stringify(outErr("Invalid JSON", "INVALID_JSON")));
				return;
			}

			if (parsed?.type === "ping") {
				ws.send(JSON.stringify(out("pong", {})));
				return;
			}

			if (parsed?.type === "read" && parsed.conversationId) {
				try {
					await MessagingService.getInstance().markRead(
						{ id: userId } as any,
						Number(parsed.conversationId),
					);
				} catch (err: any) {
					ws.send(JSON.stringify(outErr(err?.message ?? "Failed to mark read", "MARK_READ_FAILED")));
				}
				return;
			}

			/* Typing broadcast to the other participants (ephemeral, no persistence) */
			if (parsed?.type === "typing" && parsed.conversationId) {
				try {
					const conversationId = Number(parsed.conversationId);
					const repo = MessagingRepository.getInstance();
					const ok = await repo.isParticipant(conversationId, userId);
					if (!ok) return;
					const participants = await repo.getParticipantIds(conversationId);
					const envelope = {
						timestamp: new Date().toISOString(),
						status: 200,
						success: true,
						data: {
							type: "typing",
							payload: {
								conversationId,
								userId,
								name: userName,
								isTyping: parsed.isTyping !== false,
							},
						},
					};
					await Promise.allSettled(
						participants
							.filter((pid) => pid !== userId)
							.map((pid) => ChatPubSubService.getInstance().publishUser(pid, envelope)),
					);
				} catch {
					/* typing is best-effort */
				}
				return;
			}

			ws.send(JSON.stringify(outErr(`Unknown event type: ${parsed?.type ?? "?"}`, "UNKNOWN_EVENT")));
		},

		onClose: async () => {
			if (userId === null) return;
			WebsocketEngine.getInstance().remove(userId, liveWs);
			await ChatPubSubService.getInstance().unsubscribeUser(userId);
		},

		onError: (err) => {
			if (userId !== null) console.warn(`[ws] error for user ${userId}:`, (err as unknown as Error)?.message);
		},
	};
});
