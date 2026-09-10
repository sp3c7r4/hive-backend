import { Hono } from "hono";
import { JwtService, ZodEngine } from "@/services";
import { MessagingController } from "./messaging.controller";
import {
	createConversationSchema,
	listConversationsQuerySchema,
	messagesQuerySchema,
	sendMessageSchema,
} from "./messaging.schema";

/** @info - Mounted at "/messages" (see routes/router.ts). Paths are relative:
 *          GET /conversations, POST /conversations, GET /conversations/:id/messages,
 *          POST /conversations/:id/read, POST /conversations/:id/unhide,
 *          POST /, DELETE /:id */
export const messagingRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
const zod = ZodEngine.getInstance();
const controller = MessagingController.getInstance();

messagingRouter.use("*", jwt.validateToken);

messagingRouter.get(
	"/conversations",
	zod.validate.query(listConversationsQuerySchema),
	controller.listConversations,
);
messagingRouter.get("/users", controller.searchUsers);
messagingRouter.post("/conversations", zod.validate.body(createConversationSchema), controller.createConversation);
messagingRouter.get(
	"/conversations/:id/messages",
	zod.validate.query(messagesQuerySchema),
	controller.listMessages,
);
messagingRouter.get("/conversations/:id/media", controller.listMedia);
messagingRouter.get("/conversations/:id/media", controller.listMedia);
messagingRouter.post("/conversations/:id/read", controller.markRead);
messagingRouter.delete("/conversations/:id", controller.leave);
messagingRouter.post("/conversations/:id/unhide", controller.unhide);
messagingRouter.post("/", zod.validate.body(sendMessageSchema), controller.send);
messagingRouter.delete("/:id", controller.remove);
