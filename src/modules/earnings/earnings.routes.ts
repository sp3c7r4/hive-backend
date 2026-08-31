import { Hono } from "hono";
import { JwtService } from "@/services";
import { requireAdmin } from "@/middlewares/auth/guards";
import { EarningsController } from "./earnings.controller";

/** @info - Mounted at /instructor/earnings. Instructor-scoped by authData.id. */
export const earningsRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
const controller = EarningsController.getInstance();

earningsRouter.use("*", jwt.validateToken);
earningsRouter.get("/dashboard", controller.dashboard);
earningsRouter.get("/summary", controller.summary);
earningsRouter.get("/courses", controller.courses);
earningsRouter.get("/transactions", controller.transactions);
earningsRouter.get("/trend", controller.trend);
earningsRouter.get("/reconciliation", requireAdmin, controller.reconciliation);
