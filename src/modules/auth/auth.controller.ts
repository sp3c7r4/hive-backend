import type { Context } from "hono";
import { sendSuccessResponse } from "@/helpers";
import { formDataToObject } from "@/helpers/middleware";
import { AuthService } from "./auth.service";

export class AuthController {
	private static instance: AuthController;

	/** @info - Services */
	private readonly authService: AuthService = AuthService.getInstance();

	/** @returns {AuthController} */
	static getInstance(): AuthController {
		if (!this.instance) {
			this.instance = new AuthController();
		}
		return this.instance;
	}

	/** @private */
	private constructor() {
		this.authService = AuthService.getInstance();
	}

	signup = async (c: Context) => {
		const data = await c.req.json();
		const clientMetadata = c.get("clientMetadata");
		const result = await this.authService.signup({
			...data,
			...clientMetadata,
		});

		return sendSuccessResponse(c, {
			message: "Signup successful! Please verify your email.",
			...result,
		});
	};

	login = async (c: Context) => {
		const data = await c.req.json();
		const clientMetadata = c.get("clientMetadata");
		const result = await this.authService.login({
			...data,
			...clientMetadata,
		});
		return sendSuccessResponse(c, {
			...result,
		});
	};

	refreshToken = async (c: Context) => {
		const { refreshToken } = await c.req.json();
		const result = await this.authService.refresh(refreshToken);
		return sendSuccessResponse(c, {
			message: "Token refreshed successfully!",
			...result,
		});
	};

	logout = async (c: Context) => {
		const { refreshToken } = await c.req.json();
		await this.authService.logout(refreshToken);
		return sendSuccessResponse(c, {
			message: "Logged out successfully.",
		});
	};

	logoutAll = async (c: Context) => {
		const { refreshToken } = await c.req.json();
		await this.authService.logoutAll(refreshToken);
		return sendSuccessResponse(c, {
			message: "Logged out from all devices successfully.",
		});
	};

	me = async (c: Context) => {
		const authData = c.get("authData");
		const data = await this.authService.me(authData);
		return sendSuccessResponse(c, {
			message: "Authenticated user fetched successfully.",
			data,
		});
	};

	verifyEmail = async (c: Context) => {
		const data = c.get("authData");
		console.log(data);
		const { otp } = await c.req.json();
		const result = await this.authService.verifyEmail(data, otp);
		return sendSuccessResponse(c, {
			message: "Email verified successfully.",
			...result,
		});
	};

	resendOtp = async (c: Context) => {
		const data = c.get("authData");
		const result = await this.authService.resendOtp(data);
		return sendSuccessResponse(c, {
			message: "A new code has been sent.",
			...result,
		});
	};

	forgotPassword = async (c: Context) => {
		const { email } = await c.req.json();
		const clientMetadata = c.get("clientMetadata");
		const result = await this.authService.forgotPassword(email, clientMetadata);
		return sendSuccessResponse(c, {
			message: "A password reset code has been sent to your email.",
			...result,
		});
	};

	resetPassword = async (c: Context) => {
		const authData = c.get("authData");
		const { password } = await c.req.json();

		await this.authService.resetPassword(authData, password);

		return sendSuccessResponse(c, {
			message:
				"Password reset successfully. Please login with your new password.",
		});
	};

	selectRole = async (c: Context) => {
		const authData = c.get("authData");
		const { role } = await c.req.json();
		const result = await this.authService.selectRole(authData, role);
		return sendSuccessResponse(c, {
			message: `Role "${role}" added successfully.`,
			data: result,
		});
	};
}
