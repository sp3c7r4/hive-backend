import type { Context } from "hono";
import { sendSuccessResponse, sendErrorResponse } from "@/helpers";
import { CommunityService } from "./community.service";
import { StatusCodes } from "http-status-codes";

export class CommunityController {
	private static instance: CommunityController;

	private readonly service: CommunityService;

	static getInstance(): CommunityController {
		if (!this.instance) this.instance = new CommunityController();
		return this.instance;
	}

	private constructor() {
		this.service = CommunityService.getInstance();
	}

	create = async (c: Context) => {
		const authData = c.get("authData");
		const body = await c.req.json();

		const community = await this.service.create({
			...body,
			ownerId: Number(authData.id),
		});

		return sendSuccessResponse(c, community, StatusCodes.CREATED);
	};

	getBySlug = async (c: Context) => {
		const { slug } = c.req.param();
		const community = await this.service.getBySlug(slug);
		if (!community) {
			return sendErrorResponse(
				c,
				{ message: "Community not found" },
				StatusCodes.NOT_FOUND,
			);
		}
		return sendSuccessResponse(c, community);
	};

	list = async (c: Context) => {
		const page = Number(c.req.query("page") ?? "1");
		const limit = Number(c.req.query("limit") ?? "20");
		const result = await this.service.list(page, limit);
		return sendSuccessResponse(c, result);
	};

	update = async (c: Context) => {
		const { id } = c.req.param();
		const body = await c.req.json();
		const community = await this.service.update(Number(id), body);
		return sendSuccessResponse(c, community);
	};

	delete = async (c: Context) => {
		const { id } = c.req.param();
		await this.service.delete(Number(id));
		return sendSuccessResponse(c, { message: "Community deleted" });
	};
}
