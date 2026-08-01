import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendSuccessResponse, sendErrorResponse } from "@/helpers";
import { CertificateService } from "./certificate.service";

export class CertificateController {
	private static instance: CertificateController;

	private readonly service: CertificateService;

	static getInstance(): CertificateController {
		if (!this.instance) this.instance = new CertificateController();
		return this.instance;
	}

	private constructor() {
		this.service = CertificateService.getInstance();
	}

	/** @info - Issue certificate after meeting requirements */
	issue = async (c: Context) => {
		const authData = c.get("authData");
		const body = await c.req.json();

		try {
			const cert = await this.service.issue({
				userId: Number(authData.id),
				...body,
			});
			return sendSuccessResponse(c, cert, StatusCodes.CREATED);
		} catch (error: any) {
			return sendErrorResponse(
				c,
				{ message: error.message },
				StatusCodes.UNPROCESSABLE_ENTITY,
			);
		}
	};

	/** @info - Public verification — no auth required */
	verify = async (c: Context) => {
		const { code } = c.req.param();
		const cert = await this.service.verify(code);

		if (!cert) {
			return sendErrorResponse(
				c,
				{ message: "Certificate not found" },
				StatusCodes.NOT_FOUND,
			);
		}

		return sendSuccessResponse(c, cert);
	};

	list = async (c: Context) => {
		const authData = c.get("authData");
		const certs = await this.service.getUserCertificates(
			Number(authData.id),
		);
		return sendSuccessResponse(c, certs);
	};
}
