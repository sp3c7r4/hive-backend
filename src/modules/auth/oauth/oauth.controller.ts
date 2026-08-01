import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { AuthMethods, UserRole } from "@/enums";
import { sendSuccessResponse } from "@/helpers";
import { FacebookOAuthService } from "./services/facebook.oauth.service";
import { GoogleOAuthService } from "./services/google.oauth.service";

interface Service {
	service: GoogleOAuthService | FacebookOAuthService;
}

type SupportedAuthMethods = Exclude<
	AuthMethods,
	AuthMethods.EMAIL | AuthMethods.GITHUB
>;
type ServiceMapper = Record<SupportedAuthMethods, Service>;
export class OauthController {
	private static instance: OauthController;
	private serviceMapper: ServiceMapper | null = null;

	/** @returns {OauthController} */
	static getInstance() {
		if (!this.instance) {
			this.instance = new OauthController();
		}
		return this.instance;
	}

	private constructor() {}

	private getServiceMapper(): ServiceMapper {
		if (!this.serviceMapper) {
			this.serviceMapper = {
				[AuthMethods.GOOGLE]: { service: GoogleOAuthService.getInstance() },
				[AuthMethods.FACEBOOK]: { service: FacebookOAuthService.getInstance() },
			};
		}
		return this.serviceMapper;
	}

	private resolveService(provider: SupportedAuthMethods) {
		return this.getServiceMapper()[provider];
	}

	private authenticateGoogle = async (c: Context) => {
		const { service } = this.resolveService(AuthMethods.GOOGLE);
		const { role } = c.req.query();
		const data = await service.authenticate(role as UserRole);
		console.log(data);
		return sendSuccessResponse(c, {
			message: "Google Oauth url generated successfully",
			data: {
				url: data,
			},
		});
	};

	private callback = async (c: Context) => {
		const { service } = this.resolveService(AuthMethods.GOOGLE);
		const { code, state } = c.req.query();
		const data = await service.callback(code as string, state as string);
		return c.html(data, StatusCodes.OK);
	};

	google: Record<string, any> = {
		authenticate: (c: Context) => this.authenticateGoogle(c),
		callback: (c: Context) => this.callback(c),
	};

	private authenticateFacebook = async (c: Context) => {
		const { service } = this.resolveService(AuthMethods.FACEBOOK);
		const { role } = c.req.query();
		const data = await service.authenticate(role as UserRole);
		return sendSuccessResponse(c, {
			message: "Facebook Oauth url generated successfully",
			data: {
				url: data,
			},
		});
	};

	private callbackFacebook = async (c: Context) => {
		const { service } = this.resolveService(AuthMethods.FACEBOOK);
		const { code, state } = c.req.query();
		const data = await service.callback(code as string, state as string);
		return c.html(data, StatusCodes.OK);
	};

	facebook: Record<string, any> = {
		authenticate: (c: Context) => this.authenticateFacebook(c),
		callback: (c: Context) => this.callbackFacebook(c),
	};
}
