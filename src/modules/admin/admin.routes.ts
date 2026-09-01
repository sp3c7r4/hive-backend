import { Hono } from "hono";
import { JwtService } from "@/services/jwt.service";
import { requireAdmin } from "@/middlewares/auth/guards";
import { AdminController } from "./admin.controller";

/** @info - Mounted at /admin. Admin-only (requireAdmin). */
export const adminRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
const controller = AdminController.getInstance();

adminRouter.use("*", jwt.validateToken, requireAdmin);
adminRouter.get("/dashboard", controller.dashboard);
