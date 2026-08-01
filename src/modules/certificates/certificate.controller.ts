import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendSuccessResponse } from "@/helpers";
import { throwNotFoundError } from "@/helpers/errors/throw-errors";
import { CertificateMessages } from "./certificate.message";
import { CertificateService } from "./certificate.service";

export class CertificateController {
	private static instance: CertificateController;
	private service: CertificateService;

	static getInstance(): CertificateController {
		if (!this.instance) this.instance = new CertificateController();
		return this.instance;
	}

	private constructor() {
		this.service = CertificateService.getInstance();
	}

	issue = async (c: Context) => {
		const authData = c.get("authData");
		const data = await this.service.issue(authData, await c.req.json());
		return sendSuccessResponse(c, {
			message: "Certificate issued successfully",
			data,
		}, StatusCodes.CREATED);
	};

	/* Public verification — no auth */
	verify = async (c: Context) => {
		const code = c.req.param("code");
		const data = await this.service.verify(code as string);

		if (!data) throwNotFoundError(CertificateMessages.NOT_FOUND);

		return sendSuccessResponse(c, {
			message: "Certificate verified successfully",
			data,
		});
	};

	list = async (c: Context) => {
		const authData = c.get("authData");
		const data = await this.service.getUserCertificates(authData);
		return sendSuccessResponse(c, {
			message: "Certificates fetched successfully",
			data,
		});
	};
}
