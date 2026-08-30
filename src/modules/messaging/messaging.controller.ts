import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendSuccessResponse } from "@/helpers";
import { MessagingService } from "./messaging.service";

export class MessagingController {
	private static instance: MessagingController;

	static getInstance(): MessagingController {
		if (!this.instance) this.instance = new MessagingController();
		return this.instance;
	}

	private service: MessagingService;

	private constructor() {
		this.service = MessagingService.getInstance();
	}

	listConversations = async (c: Context) => {
		const authData = c.get("authData");
		const data = await this.service.list(authData);
		return sendSuccessResponse(c, { message: "Conversations fetched", data });
	};

	searchUsers = async (c: Context) => {
		const authData = c.get("authData");
		const q = c.req.query("q") ?? "";
		const data = await this.service.searchUsers(authData, q);
		return sendSuccessResponse(c, { message: "Users fetched", data });
	};

	createConversation = async (c: Context) => {
		const authData = c.get("authData");
		const body = (await c.req.json()) as { participantId: number };
		const data = await this.service.createConversation(authData, body.participantId);
		return sendSuccessResponse(c, { message: "Conversation created", data }, StatusCodes.CREATED);
	};

	listMessages = async (c: Context) => {
		const authData = c.get("authData");
		const query = c.req.query();
		const id = Number(c.req.param("id"));
		const before = query.before ? Number(query.before) : undefined;
		const limit = query.limit ? Number(query.limit) : undefined;
		const data = await this.service.listMessages(authData, id, before, limit ?? 30);
		return sendSuccessResponse(c, { message: "Messages fetched", data });
	};

	send = async (c: Context) => {
		const authData = c.get("authData");
		const body = (await c.req.json()) as any;
		const data = await this.service.send(authData, body);
		return sendSuccessResponse(c, { message: "Message sent", data }, StatusCodes.CREATED);
	};

	markRead = async (c: Context) => {
		const authData = c.get("authData");
		const id = Number(c.req.param("id"));
		const data = await this.service.markRead(authData, id);
		return sendSuccessResponse(c, { message: "Conversation marked as read", data });
	};

	leave = async (c: Context) => {
		const authData = c.get("authData");
		const id = Number(c.req.param("id"));
		const data = await this.service.leaveConversation(authData, id);
		return sendSuccessResponse(c, { message: "Conversation removed", data });
	};

	remove = async (c: Context) => {
		const authData = c.get("authData");
		const id = Number(c.req.param("id"));
		const data = await this.service.remove(authData, id);
		return sendSuccessResponse(c, { message: "Message deleted", data });
	};
}
