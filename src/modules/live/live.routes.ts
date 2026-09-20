import { Hono } from "hono";
import { JwtService, ZodEngine } from "@/services";
import { LiveController } from "./live.controller";
import {
	createLiveSessionSchema,
	muteParticipantSchema,
	updateLiveSessionSchema,
} from "./live-session.schema";

/** @info - Live sessions: session-keyed, mounted at /live. The lesson-keyed
 *  endpoints that used to live at /lessons were deleted in phase 1, not deprecated. */
export const liveRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
const zod = ZodEngine.getInstance();
const controller = LiveController.getInstance();

/** @info - Every live route requires an authenticated user; the service then applies
 *  the access rule (host / enrolled / active member) per session. */
liveRouter.use("*", jwt.validateToken);

/** @info - Session detail for the room page (access-checked; a finished session still renders) */
liveRouter.get("/sessions/:sessionId", controller.getSession);

/** @info - Join token: entitlement is checked per session by the service */
liveRouter.post("/sessions/:sessionId/token", controller.liveToken);

/** @info - Session state transitions: the host (or a standalone event's owner/admin) */
liveRouter.post("/sessions/:sessionId/go-live", controller.goLive);
liveRouter.post("/sessions/:sessionId/end-live", controller.endLive);

/**
 * @info - Recording (phase 5a). No `requireInstructor` and no body schema: a lesson's
 * recording is host-only, a standalone event's is its host's too, and the service holds the
 * authorization exactly as the token and moderation routes do. Ending the session stops the
 * recorder, so `/end-live` above is the other half of these two. See the phase 5b pair
 * (playback URL and delete) below.
 */
liveRouter.post(
	"/sessions/:sessionId/recording/start",
	controller.startRecording,
);
liveRouter.post(
	"/sessions/:sessionId/recording/stop",
	controller.stopRecording,
);

/**
 * @info - Playback and delete (phase 5b). GET, because minting a URL changes nothing
 * server-side, and the same reason as above for the missing `requireInstructor`:
 * `resolveAccess` is the gate, and the download rule (the managing side only) is applied by
 * the service after it. Deleting is host-only, in the same service.
 */
liveRouter.get("/sessions/:sessionId/recording/url", controller.recordingUrl);
liveRouter.delete("/sessions/:sessionId/recording", controller.deleteRecording);

/**
 * @info - Standalone community events (phase 2). Authorization lives in the service
 * because a community owner/admin schedules these and need not be an instructor, so
 * `requireInstructor` deliberately does not apply here.
 */
liveRouter.post(
	"/communities/:communityId/sessions",
	zod.validate.body(createLiveSessionSchema),
	controller.createSession,
);
liveRouter.get(
	"/communities/:communityId/sessions",
	controller.listCommunitySessions,
);
liveRouter.patch(
	"/sessions/:sessionId",
	zod.validate.body(updateLiveSessionSchema),
	controller.updateSession,
);
liveRouter.post("/sessions/:sessionId/cancel", controller.cancelSession);
liveRouter.delete("/sessions/:sessionId", controller.deleteSession);

/**
 * @info - In-room moderation (phase 3). Same reason as phase 2 for the missing
 * `requireInstructor`: a community owner/admin moderates a standalone event and need
 * not be an instructor, so authorization lives in the service. The gate order there -
 * access, then moderator, then room kind and live status, and only then the target
 * identity - is what keeps a non-moderator from learning anything from these routes.
 */
liveRouter.post(
	"/sessions/:sessionId/participants/:identity/mute",
	zod.validate.body(muteParticipantSchema),
	controller.muteParticipant,
);
liveRouter.post(
	"/sessions/:sessionId/participants/:identity/remove",
	controller.removeParticipant,
);
liveRouter.post(
	"/sessions/:sessionId/participants/:identity/readmit",
	controller.readmitParticipant,
);
liveRouter.get(
	"/sessions/:sessionId/participants/removed",
	controller.listRemovedParticipants,
);
