import { Hono } from "hono";
import { JwtService, ZodEngine } from "@/services";
import { LiveController } from "./live.controller";
import {
	createLiveSessionSchema,
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
