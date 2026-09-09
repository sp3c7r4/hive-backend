import { Hono } from "hono";
import { requireAdmin, requireInstructor } from "@/middlewares/auth/guards";
import { JwtService } from "@/services";
import { EarningsController } from "./earnings.controller";

/** @info - Mounted at /instructor/earnings. Instructor role required
 * (user_roles), then scoped by authData.id. /reconciliation is admin-only
 * and deliberately does NOT inherit the instructor gate. */
export const earningsRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
const controller = EarningsController.getInstance();

earningsRouter.use("*", jwt.validateToken);
earningsRouter.get("/dashboard", requireInstructor, controller.dashboard);
earningsRouter.get("/summary", requireInstructor, controller.summary);
earningsRouter.get("/courses", requireInstructor, controller.courses);
earningsRouter.get("/transactions", requireInstructor, controller.transactions);
earningsRouter.get("/trend", requireInstructor, controller.trend);
earningsRouter.get("/reconciliation", requireAdmin, controller.reconciliation);
