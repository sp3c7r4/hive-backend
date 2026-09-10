import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendSuccessResponse } from "@/helpers";
import { MessagingService } from "./messaging.service";

/** @info - zValidator stores the parsed query under the request's validation
 *          targets; the plain Context type does not expose that generic, so read
 *          it through this narrow accessor instead of the raw query string. */
const validatedQuery = <T>(c: Context): T => {
	const req = c.req as unknown as {
		valid: (target: "query") => T | undefined;
	};
	return (req.valid("query") ?? {}) as T;
};

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
		const { includeHidden } = validatedQuery<{ includeHidden?: boolean }>(c);
		const data = await this.service.list(authData, { includeHidden });
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

	listMedia = async (c: Context) => {
		const authData = c.get("authData");
		const id = Number(c.req.param("id"));
		const tab = c.req.query("tab") ?? "images";
		const data = await this.service.listMedia(authData, id, tab);
		return sendSuccessResponse(c, { message: "Media fetched", data });
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

	unhide = async (c: Context) => {
		const authData = c.get("authData");
		const id = Number(c.req.param("id"));
		const data = await this.service.unhideConversation(authData, id);
		return sendSuccessResponse(c, { message: "Conversation restored", data });
	};

	remove = async (c: Context) => {
		const authData = c.get("authData");
		const id = Number(c.req.param("id"));
		const data = await this.service.remove(authData, id);
		return sendSuccessResponse(c, { message: "Message deleted", data });
	};
}
