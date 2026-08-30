import { Hono } from "hono";
import { JwtService } from "@/services";
import { CommunityMemberController } from "./community-member.controller";

/**
 * @info - Top-level aggregate member routes for the instructor dashboard.
 *         Lives OUTSIDE /communities/:slug to avoid colliding with the slug param.
 *         Security: every query is scoped by communities.ownerId = authData.id,
 *         so non-owners (e.g. students) simply get an empty result — no data
 *         leak, and the dashboard page degrades to its empty state.
 */
export const memberRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
const controller = CommunityMemberController.getInstance();

memberRouter.use("*", jwt.validateToken);
memberRouter.get("/", controller.listMine);
