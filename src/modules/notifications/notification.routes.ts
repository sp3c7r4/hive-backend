import { Hono } from "hono";
import { JwtService } from "@/services";

const jwt = JwtService.getInstance();
import { NotificationController } from "./notification.controller";

const notificationRouter = new Hono({ strict: true });
const controller = NotificationController.getInstance();

notificationRouter.use("*", jwt.validateToken);

notificationRouter.get("/", controller.listMine);
notificationRouter.get("/unread-count", controller.unreadCount);
notificationRouter.patch("/:id/read", controller.markRead);
notificationRouter.post("/read-all", controller.markAllRead);

export { notificationRouter };
