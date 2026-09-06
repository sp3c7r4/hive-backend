import type { Context } from "hono";
import { sendSuccessResponse } from "@/helpers";
import { CalendarService } from "./calendar.service";

export class CalendarController {
	private static instance: CalendarController;
	private readonly service = CalendarService.getInstance();

	static getInstance(): CalendarController {
		if (!this.instance) this.instance = new CalendarController();
		return this.instance;
	}

	/** @info - GET /calendar/events?month=YYYY-MM */
	listEvents = async (c: Context) => {
		const authData = c.get("authData");
		const { month } = c.req.query();
		const events = await this.service.listEvents(authData, month ?? "");
		return sendSuccessResponse(c, events);
	};
}
