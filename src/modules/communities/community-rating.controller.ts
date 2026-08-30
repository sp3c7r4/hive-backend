import type { Context } from "hono";
import { sendSuccessResponse } from "@/helpers";
import { CommunityRatingService } from "./community-rating.service";

export class CommunityRatingController {
	private static instance: CommunityRatingController;
	private service: CommunityRatingService;

	static getInstance(): CommunityRatingController {
		if (!this.instance) this.instance = new CommunityRatingController();
		return this.instance;
	}

	private constructor() {
		this.service = CommunityRatingService.getInstance();
	}

	rate = async (c: Context) => {
		const authData = c.get("authData");
		const slug = c.req.param("slug") as string;
		const { rating } = await c.req.json();
		const data = await this.service.rate(authData, slug, rating);
		return sendSuccessResponse(c, { message: "Rating saved", data });
	};

	list = async (c: Context) => {
		const authData = c.get("authData");
		const slug = c.req.param("slug") as string;
		const data = await this.service.list(authData, slug);
		return sendSuccessResponse(c, { message: "Ratings fetched", data });
	};
}
