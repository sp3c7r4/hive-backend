import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendSuccessResponse } from "@/helpers";
import { CommunityFeedService } from "./community-feed.service";

export class CommunityFeedController {
	private static instance: CommunityFeedController;
	private service: CommunityFeedService;

	static getInstance(): CommunityFeedController {
		if (!this.instance) this.instance = new CommunityFeedController();
		return this.instance;
	}

	private constructor() {
		this.service = CommunityFeedService.getInstance();
	}

	/* ── Posts ───────────────────────────────────────────────── */

	listPosts = async (c: Context) => {
		const authData = c.get("authData");
		const slug = c.req.param("slug") as string;
		const page = Number(c.req.query("page") ?? "1");
		const limit = Number(c.req.query("limit") ?? "20");

		const data = await this.service.listPosts(authData, slug, { page, limit });
		return sendSuccessResponse(c, {
			message: "Posts fetched successfully",
			data,
		});
	};

	createPost = async (c: Context) => {
		const authData = c.get("authData");
		const slug = c.req.param("slug") as string;
		const body = await c.req.json();

		const data = await this.service.createPost(authData, slug, body);
		return sendSuccessResponse(
			c,
			{ message: "Post created successfully", data },
			StatusCodes.CREATED,
		);
	};

	updatePost = async (c: Context) => {
		const authData = c.get("authData");
		const postId = Number(c.req.param("postId"));
		const body = await c.req.json();

		const data = await this.service.updatePost(authData, postId, body);
		return sendSuccessResponse(c, {
			message: "Post updated successfully",
			data,
		});
	};

	deletePost = async (c: Context) => {
		const authData = c.get("authData");
		const postId = Number(c.req.param("postId"));

		await this.service.deletePost(authData, postId);
		return sendSuccessResponse(c, {
			message: "Post deleted successfully",
		});
	};

	/* ── Likes ───────────────────────────────────────────────── */

	toggleLike = async (c: Context) => {
		const authData = c.get("authData");
		const postId = Number(c.req.param("postId"));

		const data = await this.service.toggleLike(authData, postId);
		return sendSuccessResponse(c, {
			message: data.liked ? "Post liked" : "Post unliked",
			data,
		});
	};

	/* ── Comments ────────────────────────────────────────────── */

	listComments = async (c: Context) => {
		const authData = c.get("authData");
		const postId = Number(c.req.param("postId"));

		const data = await this.service.listComments(authData, postId);
		return sendSuccessResponse(c, {
			message: "Comments fetched successfully",
			data,
		});
	};

	createComment = async (c: Context) => {
		const authData = c.get("authData");
		const postId = Number(c.req.param("postId"));
		const body = await c.req.json();

		const data = await this.service.createComment(authData, postId, body);
		return sendSuccessResponse(
			c,
			{ message: "Comment created successfully", data },
			StatusCodes.CREATED,
		);
	};

	updateComment = async (c: Context) => {
		const authData = c.get("authData");
		const commentId = Number(c.req.param("commentId"));
		const body = await c.req.json();

		const data = await this.service.updateComment(authData, commentId, body);
		return sendSuccessResponse(c, {
			message: "Comment updated successfully",
			data,
		});
	};

	deleteComment = async (c: Context) => {
		const authData = c.get("authData");
		const commentId = Number(c.req.param("commentId"));

		await this.service.deleteComment(authData, commentId);
		return sendSuccessResponse(c, {
			message: "Comment deleted successfully",
		});
	};
}
