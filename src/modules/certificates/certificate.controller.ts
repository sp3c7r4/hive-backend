import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendSuccessResponse } from "@/helpers";
import { throwNotFoundError } from "@/helpers/errors/throw-errors";
import { CertificateMessages } from "./certificate.message";
import { CertificateService } from "./certificate.service";

export class CertificateController {
	private static instance: CertificateController | null;

	/** @info - Services */
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

		const cert = await this.service.issue({
			userId: Number(authData.id),
			...body,
		});

		return sendSuccessResponse(c, cert, StatusCodes.CREATED);
	};

	/** @info - Public verification — no auth required */
	verify = async (c: Context) => {
		const code = c.req.param("code")!;
		const cert = await this.service.verify(code);

		if (!cert) throwNotFoundError(CertificateMessages.NOT_FOUND);

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
