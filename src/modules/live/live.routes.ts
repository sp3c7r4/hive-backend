import { Hono } from "hono";
import { JwtService } from "@/services";
import { LiveController } from "./live.controller";

/** @info - Live sessions (phase 1): session-keyed, mounted at /live. The lesson-keyed
 *  endpoints that used to live at /lessons were deleted, not deprecated. */
export const liveRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
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
