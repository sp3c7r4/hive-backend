import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendSuccessResponse } from "@/helpers";
import { CommunityService } from "./community.service";

export class CommunityController {
	private static instance: CommunityController;
	private service: CommunityService;

	static getInstance(): CommunityController {
		if (!this.instance) this.instance = new CommunityController();
		return this.instance;
	}

	private constructor() {
		this.service = CommunityService.getInstance();
	}

	create = async (c: Context) => {
		const authData = c.get("authData");
		const data = await this.service.create(authData, await c.req.json());
		return sendSuccessResponse(c, {
			message: "Community created successfully",
			data,
		}, StatusCodes.CREATED);
	};

	list = async (c: Context) => {
		const page = Number(c.req.query("page") ?? "1");
		const limit = Number(c.req.query("limit") ?? "20");
		const data = await this.service.list({ page, limit });
		return sendSuccessResponse(c, {
			message: "Communities fetched successfully",
			data,
		});
	};

	getBySlug = async (c: Context) => {
		const slug = c.req.param("slug");
		const data = await this.service.getBySlug(slug as string);
		return sendSuccessResponse(c, {
			message: "Community fetched successfully",
			data,
		});
	};

	update = async (c: Context) => {
		const id = c.req.param("id");
		const data = await this.service.update(
			id as unknown as number,
			await c.req.json(),
		);
		return sendSuccessResponse(c, {
			message: "Community updated successfully",
			data,
		});
	};

	delete = async (c: Context) => {
		const id = c.req.param("id");
		await this.service.delete(id as unknown as number);
		return sendSuccessResponse(c, {
			message: "Community deleted successfully",
		});
	};

	/* Analytics */

	analytics = async (c: Context) => {
		const slug = c.req.param("slug");
		const from = c.req.query("from");
		const to = c.req.query("to");
		const data = await this.service.analytics(slug as string, { from, to });
		return sendSuccessResponse(c, {
			message: "Community analytics fetched successfully",
			data,
		});
	};
}
