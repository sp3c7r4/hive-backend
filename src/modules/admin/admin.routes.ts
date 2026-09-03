import { Hono } from "hono";
import { JwtService } from "@/services/jwt.service";
import { requireAdmin } from "@/middlewares/auth/guards";
import { z } from "zod";
import { ZodEngine } from "@/services";
import { AdminController } from "./admin.controller";


const certificateSettingsSchema = z.object({
	directorName: z.string().trim().min(1).max(120).optional(),
	directorSignature: z.string().trim().max(1000).optional(),
});
/** @info - Mounted at /admin. Admin-only (requireAdmin). */
export const adminRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
const zod = ZodEngine.getInstance();
const controller = AdminController.getInstance();

adminRouter.use("*", jwt.validateToken, requireAdmin);
adminRouter.get("/dashboard", controller.dashboard);
adminRouter.get("/users", controller.users);
adminRouter.get("/users/:id", controller.userDetail);
adminRouter.get("/payments", controller.payments);
adminRouter.get("/communities", controller.communities);
adminRouter.get("/activity-logs", controller.activityLogs);
adminRouter.patch("/users/:id/action", controller.userAction);
adminRouter.get("/settings/certificates", controller.getCertificateSettings);
adminRouter.put("/settings/certificates", zod.validate.body(certificateSettingsSchema), controller.updateCertificateSettings);
