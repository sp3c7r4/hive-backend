import { Hono } from "hono";
import { ZodEngine } from "@/services";
import { TestController } from "./test.controller";
import { z } from "zod";

const zod = ZodEngine.getInstance();

export const testRouter = new Hono({ strict: true });
const controller = TestController.getInstance();

const createTestSchema = z.object({
	name: z.string().min(1, "Name is required"),
	description: z.string().optional(),
});

const updateTestSchema = z.object({
	name: z.string().min(1).optional(),
	description: z.string().optional(),
});

testRouter.get("/", controller.getAll);
testRouter.get("/:id", controller.getById);
testRouter.post("/", zod.validate.body(createTestSchema), controller.create);
testRouter.patch("/:id", zod.validate.body(updateTestSchema), controller.update);
testRouter.delete("/:id", controller.delete);

export default testRouter;
