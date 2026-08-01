import { Hono } from "hono";
import { JwtService, ZodEngine } from "@/services";
import { CommunityController } from "./community.controller";
import { createCommunitySchema, updateCommunitySchema } from "./community.schema";

export const communityRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
const zod = ZodEngine.getInstance();
const controller = CommunityController.getInstance();

/** @info - All community routes require auth */
communityRouter.use("*", jwt.validateToken);

communityRouter.post("/", zod.validate.body(createCommunitySchema), controller.create);
communityRouter.get("/", controller.list);
communityRouter.get("/:slug", controller.getBySlug);
communityRouter.get("/:slug/analytics", controller.analytics);
communityRouter.patch("/:id", zod.validate.body(updateCommunitySchema), controller.update);
communityRouter.delete("/:id", controller.delete);
