import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendSuccessResponse } from "@/helpers";
import { ReviewService } from "./review.service";

export class ReviewController {
	private static instance: ReviewController;

	static getInstance(): ReviewController {
		if (!this.instance) this.instance = new ReviewController();
		return this.instance;
	}

	private reviewService: ReviewService;

	private constructor() {
		this.reviewService = ReviewService.getInstance();
	}

	create = async (c: Context) => {
		const authData = c.get("authData");
		const body = await c.req.json();
		const data = await this.reviewService.create(authData, body);
		return sendSuccessResponse(
			c,
			{ message: "Review saved", data },
			StatusCodes.CREATED,
		);
	};

	toggleHelpful = async (c: Context) => {
		const authData = c.get("authData");
		const reviewId = Number(c.req.param("id"));
		const data = await this.reviewService.toggleHelpful(authData, reviewId);
		return sendSuccessResponse(c, { message: "Updated", data });
	};

	listByCourse = async (c: Context) => {
		const courseId = Number(c.req.param("courseId"));
		const authData = c.get("authData");
		const data = await this.reviewService.listByCourse(courseId, authData);
		return sendSuccessResponse(c, {
			message: "Reviews fetched successfully",
			data,
		});
	};

	myReview = async (c: Context) => {
		const authData = c.get("authData");
		const courseId = Number(c.req.param("courseId"));
		const data = await this.reviewService.myReview(authData, courseId);
		return sendSuccessResponse(c, {
			message: "Review fetched successfully",
			data,
		});
	};
}
