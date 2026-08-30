import type { Context } from "hono";
import { sendSuccessResponse } from "@/helpers";
import { WithdrawalService } from "./withdrawal.service";

export class WithdrawalController {
	private static instance: WithdrawalController;
	private service: WithdrawalService;

	static getInstance(): WithdrawalController {
		if (!this.instance) this.instance = new WithdrawalController();
		return this.instance;
	}

	private constructor() {
		this.service = WithdrawalService.getInstance();
	}

	create = async (c: Context) => {
		const authData = c.get("authData");
		const body = await c.req.json();
		const data = await this.service.create(authData, body);
		return sendSuccessResponse(c, { message: "Withdrawal requested", data });
	};

	verifyAccount = async (c: Context) => {
		const authData = c.get("authData");
		const body = await c.req.json();
		const data = await this.service.verifyAccount(authData, body);
		return sendSuccessResponse(c, { message: "Account verified", data });
	};

	listMine = async (c: Context) => {
		const authData = c.get("authData");
		const data = await this.service.listMine(authData, {
			page: Number(c.req.query("page") ?? "1"),
			limit: Number(c.req.query("limit") ?? "30"),
		});
		return sendSuccessResponse(c, { message: "Withdrawals fetched", data });
	};

	listAdmin = async (c: Context) => {
		const data = await this.service.listAdmin({
			status: c.req.query("status") ?? undefined,
			page: Number(c.req.query("page") ?? "1"),
			limit: Number(c.req.query("limit") ?? "30"),
		});
		return sendSuccessResponse(c, { message: "Withdrawals fetched", data });
	};

	approveOrReject = async (c: Context) => {
		const id = Number(c.req.param("id"));
		const { action } = await c.req.json();
		const data =
			action === "approve"
				? await this.service.approve(id)
				: await this.service.reject(id);
		return sendSuccessResponse(c, { message: `Withdrawal ${action}d`, data });
	};
}
