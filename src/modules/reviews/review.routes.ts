import { Hono } from "hono";
import { JwtService } from "@/services/jwt.service";
import { ZodEngine } from "@/services/engine/zod.engine.service";
import { ReviewController } from "./review.controller";
import { createReviewSchema } from "./review.schema";

export const reviewRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
const zod = ZodEngine.getInstance();
const controller = ReviewController.getInstance();

reviewRouter.use("*", jwt.validateToken);

reviewRouter.post("/", zod.validate.body(createReviewSchema), controller.create);
reviewRouter.get("/course/:courseId", controller.listByCourse);
reviewRouter.patch("/:id/helpful", controller.toggleHelpful);
reviewRouter.get("/course/:courseId/mine", controller.myReview);
