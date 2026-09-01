import { Hono } from "hono";
import { JwtService } from "@/services/jwt.service";
import { StudentController } from "./student.controller";

/** @info - Mounted at /student. Student-scoped by authData.id. */
export const studentRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
const controller = StudentController.getInstance();

studentRouter.use("*", jwt.validateToken);
studentRouter.get("/dashboard", controller.dashboard);
