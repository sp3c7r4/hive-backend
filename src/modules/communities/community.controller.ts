import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendSuccessResponse } from "@/helpers";
import { formDataToObject } from "@/helpers/middleware";
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

		/* FormData path — file handled by upload middleware */
		const formData = await c.req.formData();
		const data: Record<string, any> = formDataToObject(formData);
    data.coverImageUrl = c.get("uploadedFile")?.key;

		const result = await this.service.create(authData, data as any);
		return sendSuccessResponse(c, {
			message: "Community created successfully",
			data: result,
		}, StatusCodes.CREATED);
	};

	list = async (c: Context) => {
		const authData = c.get("authData");
		const page = Number(c.req.query("page") ?? "1");
		const limit = Number(c.req.query("limit") ?? "20");
		const scope = c.req.query("scope") as "mine" | "owned" | undefined;
		const data = await this.service.list({ page, limit, userId: authData?.id, scope });
		return sendSuccessResponse(c, {
			message: "Communities fetched successfully",
			data,
		});
	};

	getBySlug = async (c: Context) => {
		const slug = c.req.param("slug");
		const authData = c.get("authData");
		const data = await this.service.getBySlug(slug as string, authData);
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
			c.get("authData"),
		);
		return sendSuccessResponse(c, {
			message: "Community updated successfully",
			data,
		});
	};

	delete = async (c: Context) => {
		const id = c.req.param("id");
		const permanent = c.req.query("permanent") === "true";
		await this.service.delete(id as unknown as number, permanent, c.get("authData"));
		return sendSuccessResponse(c, {
			message: permanent ? "Community permanently deleted" : "Community deleted successfully",
		});
	};

	restore = async (c: Context) => {
		const id = c.req.param("id");
		const data = await this.service.restore(id as unknown as number, c.get("authData"));
		return sendSuccessResponse(c, {
			message: "Community unarchived successfully",
			data,
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
