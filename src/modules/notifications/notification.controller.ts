import type { Context } from "hono";
import { sendSuccessResponse } from "@/helpers";
import { NotificationService } from "./notification.service";

export class NotificationController {
	private static instance: NotificationController;
	private service: NotificationService;

	static getInstance(): NotificationController {
		if (!this.instance) this.instance = new NotificationController();
		return this.instance;
	}

	private constructor() {
		this.service = NotificationService.getInstance();
	}

	listMine = async (c: Context) => {
		const authData = c.get("authData");
		const page = Number(c.req.query("page") ?? "1");
		const limit = Number(c.req.query("limit") ?? "20");
		const data = await this.service.listMine(Number(authData.id), { page, limit });
		return sendSuccessResponse(c, data);
	};

	unreadCount = async (c: Context) => {
		const authData = c.get("authData");
		const data = await this.service.unreadCount(Number(authData.id));
		return sendSuccessResponse(c, { count: data });
	};

	markRead = async (c: Context) => {
		const authData = c.get("authData");
		const id = Number(c.req.param("id"));
		const data = await this.service.markRead(Number(authData.id), id);
		return sendSuccessResponse(c, { updated: data });
	};

	markAllRead = async (c: Context) => {
		const authData = c.get("authData");
		await this.service.markAllRead(Number(authData.id));
		return sendSuccessResponse(c, { message: "All notifications marked as read" });
	};
}
