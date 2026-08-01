import { Hono } from "hono";
import { JwtService, ZodEngine } from "@/services";
import { CertificateController } from "./certificate.controller";
import { issueCertificateSchema } from "./certificate.schema";

export const certificateRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
const zod = ZodEngine.getInstance();
const controller = CertificateController.getInstance();

/** @info - Public certificate verification — no auth */
certificateRouter.get("/verify/:code", controller.verify);

/** @info - Protected routes */
certificateRouter.use("/issue", jwt.validateToken);
certificateRouter.post(
	"/issue",
	zod.validate.body(issueCertificateSchema),
	controller.issue,
);

certificateRouter.use("/", jwt.validateToken);
certificateRouter.get("/", controller.list);
