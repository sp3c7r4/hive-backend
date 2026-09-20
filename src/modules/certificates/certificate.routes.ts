import { Hono } from "hono";
import { JwtService } from "@/services";
import { CertificateController } from "./certificate.controller";

export const certificateRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
const controller = CertificateController.getInstance();

/* @info - There is deliberately no issuance route. Certificates are minted
 * only by the worker, from eligibility computed server-side against real
 * progress (see `evaluateCertificateEligibility`). A request-driven issuance
 * endpoint used to live here, taking its own pass marks and an
 * `allowCertificate` flag from the body: any authenticated user could issue
 * themselves a certificate that then verified publicly as genuine. If a
 * support grant is ever needed, it belongs behind `requireAdmin` with the
 * eligibility recomputed server-side. */

/** @info - Public certificate verification — no auth */
certificateRouter.get("/verify/:code", controller.verify);

/** @info - Protected routes */
certificateRouter.use("/", jwt.validateToken);
certificateRouter.get("/", controller.list);
