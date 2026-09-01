import type { Context } from "hono";
import { sendSuccessResponse } from "@/helpers";
import { StudentDashboardService } from "./student.service";

export class StudentController {
	private static instance: StudentController;

	static getInstance(): StudentController {
		if (!this.instance) this.instance = new StudentController();
		return this.instance;
	}

	private service: StudentDashboardService;

	private constructor() {
		this.service = StudentDashboardService.getInstance();
	}

	dashboard = async (c: Context) => {
		const authData = c.get("authData");
		const data = await this.service.dashboard(authData);
		return sendSuccessResponse(c, { message: "Student dashboard data fetched", data });
	};
}
