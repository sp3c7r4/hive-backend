import type { Context } from "hono";
import { sendSuccessResponse } from "@/helpers";
import { throwBadRequestError } from "@/helpers/errors/throw-errors";
import { UserService } from "@/modules/user/user.service";
import { AdminDashboardService } from "./admin.service";

export class AdminController {
	private static instance: AdminController;

	static getInstance(): AdminController {
		if (!this.instance) this.instance = new AdminController();
		return this.instance;
	}

	private service: AdminDashboardService;
	private userService: UserService;

	private constructor() {
		this.service = AdminDashboardService.getInstance();
		this.userService = UserService.getInstance();
	}

	userAction = async (c: Context) => {
		const adminId = Number(c.get("authData").id);
		const targetId = Number(c.req.param("id"));
		if (adminId === targetId)
			throwBadRequestError("You cannot take that action on your own account");

		const { action } = await c.req.json();
		const data = await this.userService.adminAction(targetId, action);
		return sendSuccessResponse(c, { message: `User ${action} handled`, data });
	};

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
