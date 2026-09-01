import type { Context } from "hono";
import { sendSuccessResponse } from "@/helpers";
import { AdminDashboardService } from "./admin.service";

export class AdminController {
	private static instance: AdminController;

	static getInstance(): AdminController {
		if (!this.instance) this.instance = new AdminController();
		return this.instance;
	}

	private service: AdminDashboardService;

	private constructor() {
		this.service = AdminDashboardService.getInstance();
	}

	users = async (c: Context) => {
		const data = await this.service.users({
			search: c.req.query("search"),
			role: c.req.query("role"),
		});
		return sendSuccessResponse(c, { message: "Users fetched", data });
	};

	dashboard = async (c: Context) => {
		const data = await this.service.dashboard();
		return sendSuccessResponse(c, { message: "Admin dashboard data fetched", data });
	};
}
