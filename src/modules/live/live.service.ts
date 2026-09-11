import { AccessToken } from "livekit-server-sdk";
import { config } from "@/config";
import { throwRateLimitError } from "@/helpers/errors/throw-errors";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { CacheService } from "@/services";
import type {
	CommunitySessionScope,
	CreateLiveSessionInput,
	UpdateLiveSessionInput,
} from "./live-session.service";
import { LiveSessionService } from "./live-session.service";

/** @info - Live join tokens are short-lived joins, not sessions */
const TOKEN_TTL_SECONDS = 2 * 60 * 60;
/** @info - 5 token requests/min/user */
const TOKEN_RATE_LIMIT = 5;

/**
 * @info - LiveKit room name for a session. Derived from the immutable session id and
 * never stored: staging and production share one LiveKit project and are separated
 * only by LIVEKIT_ROOM_PREFIX, so every participant and every deploy composes the
 * same name for the same session.
 */
export const roomNameForSession = (sessionId: number): string =>
	`${config.livekit.roomPrefix}session-${sessionId}`;

/**
 * @info - Live session endpoints, session-keyed. Every subsystem (token, room,
 * moderation, recording, links) keys on one session id; a lesson points at its
 * session through lessons.live_session_id. The lesson-keyed endpoints were deleted
 * in phase 1, not deprecated.
 */
export class LiveService {
	private static instance: LiveService;
	private readonly sessions = LiveSessionService.getInstance();

	static getInstance(): LiveService {
		if (!this.instance) this.instance = new LiveService();
		return this.instance;
	}

	/** @info - Enforce the per-user token rate limit (sliding window, 5/min). */
	private enforceTokenRateLimit = async (userId: number) => {
		const redis = CacheService.getInstance().getRedisClient();
		const key = `ratelimit:livetoken:${userId}`;
		const count = await redis.incr(key);
		if (count === 1) await redis.expire(key, 60);
		if (count > TOKEN_RATE_LIMIT) {
			throwRateLimitError(
				"Too many join attempts. Wait a minute and try again.",
			);
		}
	};

	/** @info - GET /live/sessions/:sessionId */
	getSession = async (authData: IAuthData, sessionId: number) =>
		this.sessions.getSessionView(authData, sessionId);

	/**
	 * @info - POST /live/sessions/:sessionId/token
	 * Issues a LiveKit join token. Everyone who passes the access gate may publish
	 * (camera + mic + chat data) so a live class is a conversation; the host also gets
	 * roomAdmin for server-side moderation (phase 3 uses it).
	 */
	issueToken = async (authData: IAuthData, sessionId: number) => {
		await this.enforceTokenRateLimit(Number(authData.id));
		const { session, access } = await this.sessions.loadForJoin(
			authData,
			sessionId,
		);

		const roomName = roomNameForSession(session.id);
		const displayName = [authData.firstName, authData.lastName]
			.filter(Boolean)
			.join(" ")
			.trim();
		const token = new AccessToken(
			config.livekit.apiKey,
			config.livekit.apiSecret,
			{
				identity: `user-${authData.id}`,
				name: displayName || `User ${authData.id}`,
				ttl: `${TOKEN_TTL_SECONDS}s`,
			},
		);
		token.addGrant({
			room: roomName,
			roomJoin: true,
			canPublish: true,
			canSubscribe: true,
			canPublishData: true,
			roomAdmin: access.canModerate,
		});

		return {
			token: await token.toJwt(),
			roomName,
			url: config.livekit.publicUrl,
			expiresIn: TOKEN_TTL_SECONDS,
			session: {
				id: session.id,
				status: session.status,
				isHost: access.isHost,
			},
		};
	};

	/** @info - POST /live/sessions/:sessionId/go-live — the host starts the session */
	goLive = async (authData: IAuthData, sessionId: number) => {
		const { session } = await this.sessions.loadForHostAction(
			authData,
			sessionId,
		);
		if (session.status === "live") {
			return { sessionId: session.id, status: session.status };
		}

		const updated = await this.sessions.markLive(session.id);
		return { sessionId: updated.id, status: updated.status };
	};

	/** @info - POST /live/sessions/:sessionId/end-live — the host ends the session */
	endLive = async (authData: IAuthData, sessionId: number) => {
		const { session } = await this.sessions.loadForHostAction(
			authData,
			sessionId,
		);
		if (session.status === "ended") {
			return { sessionId: session.id, status: session.status };
		}

		const updated = await this.sessions.markEnded(session.id);
		return { sessionId: updated.id, status: updated.status };
	};

	/* ── Standalone community events (phase 2) ───────────────────────── */

	/** @info - GET /live/communities/:communityId/sessions?scope=upcoming|past */
	listCommunitySessions = async (
		authData: IAuthData,
		communityId: number,
		scope: CommunitySessionScope,
	) => this.sessions.listCommunitySessions(authData, communityId, scope);

	/** @info - POST /live/communities/:communityId/sessions */
	createSession = async (
		authData: IAuthData,
		communityId: number,
		input: CreateLiveSessionInput,
	) => this.sessions.createSession(authData, communityId, input);

	/** @info - PATCH /live/sessions/:sessionId */
	updateSession = async (
		authData: IAuthData,
		sessionId: number,
		input: UpdateLiveSessionInput,
	) => this.sessions.updateSession(authData, sessionId, input);

	/** @info - POST /live/sessions/:sessionId/cancel */
	cancelSession = async (authData: IAuthData, sessionId: number) =>
		this.sessions.cancelSession(authData, sessionId);

	/** @info - DELETE /live/sessions/:sessionId */
	deleteSession = async (authData: IAuthData, sessionId: number) =>
		this.sessions.deleteSession(authData, sessionId);
}
