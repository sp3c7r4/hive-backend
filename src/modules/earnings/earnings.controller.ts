import type { Context } from "hono";
import { sendSuccessResponse } from "@/helpers";
import { EarningsService } from "./earnings.service";

export class EarningsController {
	private static instance: EarningsController;
	private service: EarningsService;

	static getInstance(): EarningsController {
		if (!this.instance) this.instance = new EarningsController();
		return this.instance;
	}

	private constructor() {
		this.service = EarningsService.getInstance();
	}

	summary = async (c: Context) => {
		const authData = c.get("authData");
		const data = await this.service.summary(authData, c.req.query("period") ?? undefined);
		return sendSuccessResponse(c, { message: "Earnings summary fetched", data });
	};

	courses = async (c: Context) => {
		const authData = c.get("authData");
		const data = await this.service.courses(authData, c.req.query("period") ?? undefined);
		return sendSuccessResponse(c, { message: "Course earnings fetched", data });
	};

	transactions = async (c: Context) => {
		const authData = c.get("authData");
		const data = await this.service.transactions(authData, {
			page: Number(c.req.query("page") ?? "1"),
			limit: Number(c.req.query("limit") ?? "30"),
		});
		return sendSuccessResponse(c, { message: "Ledger fetched", data });
	};

	trend = async (c: Context) => {
		const authData = c.get("authData");
		const data = await this.service.trend(authData, c.req.query("period") ?? undefined);
		return sendSuccessResponse(c, { message: "Earnings trend fetched", data });
	};

	reconciliation = async (c: Context) => {
		const data = await this.service.reconciliation();
		return sendSuccessResponse(c, { message: "Reconciliation fetched", data });
	};
}
