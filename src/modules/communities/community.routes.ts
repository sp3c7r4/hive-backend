import { Hono } from "hono";
import { z } from "zod";
import type { Context, Next } from "hono";
import { JwtService, ZodEngine } from "@/services";
import { FileUploadMiddleware } from "@/middlewares/upload";
import { FILE_SIZES } from "@/constants/file-size";
import { ImageMimeType } from "@/enums";
import { CommunityController } from "./community.controller";
import { CommunityMemberController } from "./community-member.controller";
import { CommunityFeedController } from "./community-feed.controller";
import { CommunityRatingController } from "./community-rating.controller";
import { createCommunitySchema, createCommunityFormSchema, updateCommunitySchema } from "./community.schema";
import { updateMemberSchema, inviteMemberSchema } from "./community-member.schema";
import { createPostSchema, updatePostSchema, createCommentSchema, updateCommentSchema } from "./community-feed.schema";
import { requireCommunityMember, requireCommunityMemberOrAdmin, requireCommunityAdmin } from "@/middlewares/auth/community-guards";

export const communityRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
const zod = ZodEngine.getInstance();
const upload = FileUploadMiddleware.getInstance();
const controller = CommunityController.getInstance();
const memberController = CommunityMemberController.getInstance();
const feedController = CommunityFeedController.getInstance();
const ratingController = CommunityRatingController.getInstance();

/** @info - Public route: community info (needed by join page for unregistered users).
 *          Optional auth: if a valid token is present, the owner can view archived communities. */
const optionalAuth = async (c: Context, next: Next) => {
	try {
		await jwt.validateToken(c, async () => {});
	} catch {
		/* no auth — treat as public */
	}
	await next();
};
communityRouter.get("/:slug", optionalAuth, controller.getBySlug);

/** @info - All other community routes require auth */
communityRouter.use("*", jwt.validateToken);

/* ── Community CRUD ────────────────────────────────────────── */

communityRouter.post(
	"/",
	zod.validate.formData(createCommunityFormSchema),
	upload.single({
		fieldName: "coverImage",
		sizeLimit: FILE_SIZES["5MB"],
		allowedTypes: [ImageMimeType.JPEG, ImageMimeType.PNG, ImageMimeType.WEBP],
		optional: true,
	}),
	controller.create,
);
communityRouter.get("/", controller.list);
communityRouter.get("/:slug/analytics", controller.analytics);
communityRouter.patch("/:id", zod.validate.body(updateCommunitySchema), controller.update);
communityRouter.delete("/:id", controller.delete);
communityRouter.post("/:id/restore", controller.restore);

/* ── Members ───────────────────────────────────────────────── */

communityRouter.get("/:slug/members", requireCommunityMemberOrAdmin, memberController.listMembers);
communityRouter.patch("/:slug/members/:userId", requireCommunityAdmin, zod.validate.body(updateMemberSchema), memberController.updateMember);
communityRouter.delete("/:slug/members/:userId", requireCommunityAdmin, memberController.removeMember);
communityRouter.post("/:slug/members/:userId/approve", requireCommunityAdmin, memberController.approveMember);
communityRouter.post("/:slug/members/:userId/reject", requireCommunityAdmin, memberController.rejectMember);

/* ── Invites ───────────────────────────────────────────────── */

communityRouter.get("/:slug/invites", requireCommunityAdmin, memberController.listInvites);
communityRouter.post("/:slug/invites", requireCommunityAdmin, zod.validate.body(inviteMemberSchema), memberController.createInvite);
communityRouter.delete("/:slug/invites/:inviteId", requireCommunityAdmin, memberController.cancelInvite);

/* ── Join / Leave ──────────────────────────────────────────── */

communityRouter.post("/:slug/join", memberController.joinCommunity);
communityRouter.post("/:slug/leave", requireCommunityMember, memberController.leaveCommunity);

/* ── Feed ──────────────────────────────────────────────────── */

communityRouter.get("/:slug/feed", requireCommunityMemberOrAdmin, feedController.listPosts);
/* @info - Only owners/admins can create posts + announcements; members comment/like */
communityRouter.post("/:slug/feed", requireCommunityAdmin, zod.validate.body(createPostSchema), feedController.createPost);
communityRouter.get("/:slug/ratings", requireCommunityMemberOrAdmin, ratingController.list);
communityRouter.post("/:slug/ratings", requireCommunityMember, zod.validate.body(z.object({ rating: z.number().int().min(1).max(5) })), ratingController.rate);
communityRouter.patch("/:slug/feed/:postId", requireCommunityMember, zod.validate.body(updatePostSchema), feedController.updatePost);
communityRouter.delete("/:slug/feed/:postId", requireCommunityMember, feedController.deletePost);

communityRouter.post("/:slug/feed/:postId/like", requireCommunityMember, feedController.toggleLike);

communityRouter.get("/:slug/feed/:postId/comments", requireCommunityMemberOrAdmin, feedController.listComments);
communityRouter.post("/:slug/feed/:postId/comments", requireCommunityMember, zod.validate.body(createCommentSchema), feedController.createComment);
communityRouter.patch("/:slug/feed/:postId/comments/:commentId", requireCommunityMember, zod.validate.body(updateCommentSchema), feedController.updateComment);
communityRouter.delete("/:slug/feed/:postId/comments/:commentId", requireCommunityMember, feedController.deleteComment);
