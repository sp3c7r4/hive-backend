import { AccessToken, TrackSource, TrackType } from "livekit-server-sdk";
import { config } from "@/config";
import { TTL } from "@/constants";
import {
	throwBadRequestError,
	throwConflictError,
	throwForbiddenError,
	throwNotFoundError,
	throwRateLimitError,
} from "@/helpers/errors/throw-errors";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { getRoomServiceClient } from "./live-room.client";
import { CacheService } from "@/services";
import { serviceLogger } from "@/utils";
import type { LiveSession } from "./live-session.model";
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
/** @info - A removed participant is told why, in plain words (spec section 5) */
const REMOVED = "You were removed from this session.";
/** @info - Mute with nothing to mute: the honest fallback, never a 200 that did nothing */
/** @info - Muting always works; unmuting remotely needs a LiveKit room option this project
 *  does not enable, so the honest answer is "ask them" (D-P3-8). */
const REMOTE_UNMUTE_UNAVAILABLE =
	"LiveKit will not unmute that participant remotely. Ask them to unmute instead.";
const NO_MIC_TRACK =
	"That participant has no microphone published. Ask them to unmute instead.";
const NOT_IN_ROOM = "That participant is not in this session.";
const MODERATE_SELF = "You cannot mute or remove yourself.";
const MODERATE_HOST = "The host cannot be muted or removed.";

/**
 * @info - LiveKit room name for a session. Derived from the immutable session id and
 * never stored: staging and production share one LiveKit project and are separated
 * only by LIVEKIT_ROOM_PREFIX, so every participant and every deploy composes the
 * same name for the same session.
 */
export const roomNameForSession = (sessionId: number): string =>
	`${config.livekit.roomPrefix}session-${sessionId}`;

/** @info - A currently-denied participant, as the moderator's roster panel needs them. */
export interface RemovedParticipant {
	identity: string;
	name: string;
	removedAt: string;
}

/**
 * @info - Live session endpoints, session-keyed. Every subsystem (token, room,
 * moderation, recording, links) keys on one session id; a lesson points at its
 * session through lessons.live_session_id. The lesson-keyed endpoints were deleted
 * in phase 1, not deprecated.
 */
export class LiveService {
	private static instance: LiveService;
	private readonly sessions = LiveSessionService.getInstance();
	private readonly log = serviceLogger("Live");

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
		/* @info - The door, checked after the access gate (so an outsider still learns
		 * nothing new) and before minting: a removed participant is told plainly why,
		 * rather than handed a token a closed door would refuse (D-P3-10). */
		if (await this.isDenied(roomName, `user-${authData.id}`)) {
			throwForbiddenError(REMOVED);
		}

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
				/* @info - The roster reads a participant's role off the participant itself, so
				 * a client never has to ask the API who the host is (D-P3-6). */
				attributes: { role: access.isHost ? "host" : "member" },
			},
		);
		token.addGrant({
			room: roomName,
			roomJoin: true,
			canPublish: true,
			canSubscribe: true,
			canPublishData: true,
			roomAdmin: access.canModerate,
			/* @info - The participant sets its own hand-raise attribute (D-P3-7); without
			 * this grant LiveKit refuses the client's own update. */
			canUpdateOwnMetadata: true,
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
		/* @info - A restarted class starts fresh: a removal lasts as long as the session
		 * does (D-P3-11/12 - deliberately not cleared when the host's connection drops,
		 * which would need LiveKit webhooks). */
		await this.clearDenyList(roomNameForSession(session.id));
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

	/* ── In-room moderation (phase 3) ─────────────────── */

	/**
	 * @info - One Redis hash per room. The key carries the derived room name, which
	 * includes LIVEKIT_ROOM_PREFIX: staging and production share a Redis *and* a LiveKit
	 * project, so a session-id key would let one environment's removal lock someone out
	 * of the other (D-P3-11).
	 */
	private denyKey = (roomName: string): string => `live:deny:${roomName}`;

	private redis = () => CacheService.getInstance().getRedisClient();

	private denyParticipant = async (
		roomName: string,
		identity: string,
		name: string,
	): Promise<void> => {
		const key = this.denyKey(roomName);
		await this.redis().hset(
			key,
			identity,
			JSON.stringify({ name, removedAt: new Date().toISOString() }),
		);
		/* @info - refreshed on every removal, so the list outlives the last one by a
		 * token's lifetime (D-P3-11) */
		await this.redis().expire(key, TTL.IN_2_HOURS);
	};

	private isDenied = async (
		roomName: string,
		identity: string,
	): Promise<boolean> =>
		(await this.redis().hexists(this.denyKey(roomName), identity)) === 1;

	private clearDenyList = async (roomName: string): Promise<void> => {
		await this.redis().del(this.denyKey(roomName));
	};

	/** @info - A stored deny-list value, read defensively: a hand-written or older entry
	 *  must never break the moderator's list. */
	private parseDenied = (raw: string): { name: string; removedAt: string } => {
		try {
			const parsed = JSON.parse(raw) as { name?: string; removedAt?: string };
			return { name: parsed.name ?? "", removedAt: parsed.removedAt ?? "" };
		} catch {
			return { name: "", removedAt: "" };
		}
	};

	/**
	 * @info - The participant as LiveKit reports them, plus the microphone to act on. A
	 * track published from MICROPHONE is preferred; failing that any audio track will do,
	 * because a client can publish a microphone without declaring the source.
	 */
	private findParticipant = async (roomName: string, identity: string) => {
		const participants =
			await getRoomServiceClient().listParticipants(roomName);
		const participant = participants.find(
			(entry) => entry.identity === identity,
		);
		if (!participant) return null;
		const audio = participant.tracks.filter(
			(track) => track.type === TrackType.AUDIO,
		);
		const mic =
			audio.find((track) => track.source === TrackSource.MICROPHONE) ??
			audio[0] ??
			null;
		return { participant, mic };
	};

	/**
	 * @info - Who may be acted on: not the host (the one person whose removal cannot be
	 * recovered from inside the room), and not the caller. Checked before any LiveKit
	 * lookup, so a refused target costs nothing and reveals nothing (D-P3-14).
	 */
	private assertModeratableTarget = (
		session: LiveSession,
		authData: IAuthData,
		identity: string,
	): void => {
		if (identity === `user-${authData.id}`) throwBadRequestError(MODERATE_SELF);
		if (identity === `user-${session.hostId}`) {
			throwBadRequestError(MODERATE_HOST);
		}
	};

	/**
	 * @info - POST /live/sessions/:sessionId/participants/:identity/mute
	 * `muted: false` is a real server-side unmute (spec fact 8), which is why the host's
	 * control needs no "ask them" fallback except when there is no microphone to act on -
	 * and that case is a 409 rather than a 200 that quietly did nothing.
	 */
	muteParticipant = async (
		authData: IAuthData,
		sessionId: number,
		identity: string,
		muted: boolean,
	): Promise<{ identity: string; muted: boolean }> => {
		const { session } = await this.sessions.loadForModeration(
			authData,
			sessionId,
		);
		this.assertModeratableTarget(session, authData, identity);

		const roomName = roomNameForSession(session.id);
		const found = await this.findParticipant(roomName, identity);
		if (!found) throwNotFoundError(NOT_IN_ROOM);
		/* @info - `mic!` because this module's error helpers are inferred const arrows:
		 * TypeScript neither narrows on them nor treats them as unreachable (the rest of the
		 * file writes `row!` for the same reason). */
		const mic = found?.mic ?? null;
		if (!mic) throwConflictError(NO_MIC_TRACK);

		/* @info - LiveKit refuses a server-side unmute unless the room enables remote
		 * unmute ("remote unmute not enabled"), which this project does not. Muting always
		 * works; unmuting is therefore an ask, which is exactly what a 409 already means to
		 * the frontend - so translate it rather than surfacing a 500 for a known condition. */
		try {
			await getRoomServiceClient().mutePublishedTrack(
				roomName,
				identity,
				mic!.sid,
				muted,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!muted && /remote unmute/i.test(message)) {
				throwConflictError(REMOTE_UNMUTE_UNAVAILABLE);
			}
			throw error;
		}
		return { identity, muted };
	};

	/**
	 * @info - POST /live/sessions/:sessionId/participants/:identity/remove
	 * Revoke, then eject, then deny: a participant who has already left the room is still
	 * denied, because the deny-list - not their presence - is what keeps them out. That is
	 * also why a missing participant is not a 404 here: a host acting on a stale roster
	 * still gets what they asked for.
	 */
	removeParticipant = async (
		authData: IAuthData,
		sessionId: number,
		identity: string,
	): Promise<{ identity: string }> => {
		const { session } = await this.sessions.loadForModeration(
			authData,
			sessionId,
		);
		this.assertModeratableTarget(session, authData, identity);

		const roomName = roomNameForSession(session.id);
		const found = await this.findParticipant(roomName, identity);
		if (found) {
			const service = getRoomServiceClient();
			try {
				/* @info - permissions first: the instant before the ejection is harmless */
				await service.updateParticipant(roomName, identity, {
					permission: {
						canPublish: false,
						canSubscribe: false,
						canPublishData: false,
					},
				});
				await service.removeParticipant(roomName, identity);
			} catch (error) {
				/* @info - They can leave between the listing and the ejection. The ejection
				 * is best-effort; the deny-list write below is what matters. */
				this.log.error(
					`live moderation: ejecting ${identity} from ${roomName} failed`,
					error,
				);
			}
		}

		await this.denyParticipant(
			roomName,
			identity,
			found?.participant.name || identity,
		);
		return { identity };
	};

	/**
	 * @info - POST /live/sessions/:sessionId/participants/:identity/readmit
	 * Lets one identity back in without ending the class (D-P3-17): the same moderators
	 * undo a misclick instead of restarting the session for everyone. Idempotent.
	 */
	readmitParticipant = async (
		authData: IAuthData,
		sessionId: number,
		identity: string,
	): Promise<{ identity: string }> => {
		const { session } = await this.sessions.loadForModeration(
			authData,
			sessionId,
		);
		await this.redis().hdel(
			this.denyKey(roomNameForSession(session.id)),
			identity,
		);
		return { identity };
	};

	/**
	 * @info - GET /live/sessions/:sessionId/participants/removed
	 * A removed participant is by definition not in the room, so this is the only place a
	 * host can find them again to undo a mistake (D-P3-17).
	 */
	listRemovedParticipants = async (
		authData: IAuthData,
		sessionId: number,
	): Promise<RemovedParticipant[]> => {
		const { session } = await this.sessions.loadForModeration(
			authData,
			sessionId,
		);
		const entries = await this.redis().hgetall(
			this.denyKey(roomNameForSession(session.id)),
		);
		/* @info - Newest first: a Redis hash has no order of its own, and the host is
		 * almost always looking for the removal they just made (D-P3-17). */
		return Object.entries(entries)
			.map(([identity, raw]) => {
				const parsed = this.parseDenied(raw);
				return { identity, name: parsed.name, removedAt: parsed.removedAt };
			})
			.sort((a, b) => b.removedAt.localeCompare(a.removedAt));
	};
}
