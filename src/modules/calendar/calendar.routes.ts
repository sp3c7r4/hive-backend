import { Hono } from "hono";
import { requireInstructor } from "@/middlewares/auth";
import { JwtService } from "@/services";
import { CalendarController } from "./calendar.controller";

export const calendarRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
const controller = CalendarController.getInstance();

calendarRouter.use("*", jwt.validateToken);

/** @info - Teaching calendar: month view + today list for instructors */
calendarRouter.get("/events", requireInstructor, controller.listEvents);
