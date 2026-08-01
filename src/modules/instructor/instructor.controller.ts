import type { Context } from "hono";
import { sendSuccessResponse } from "@/helpers";
import { InstructorService } from "./instructor.service";

export class InstructorController {
	private static instance: InstructorController;
	private service: InstructorService;

	static getInstance(): InstructorController {
		if (!this.instance) this.instance = new InstructorController();
		return this.instance;
	}

	private constructor() {
		this.service = InstructorService.getInstance();
	}

	stats = async (c: Context) => {
		const authData = c.get("authData");
		const from = c.req.query("from");
		const to = c.req.query("to");

		const data = await this.service.getStats(authData, { from, to });
		return sendSuccessResponse(c, {
			message: "Instructor stats fetched successfully",
			data,
		});
	};

	liveClasses = async (c: Context) => {
		const authData = c.get("authData");
		const page = Number(c.req.query("page") ?? "1");
		const limit = Number(c.req.query("limit") ?? "5");
		const filter = c.req.query("filter");

		const data = await this.service.getLiveClasses(authData, {
			page,
			limit,
			filter,
		});
		return sendSuccessResponse(c, {
			message: "Live classes fetched successfully",
			data,
		});
	};
}
