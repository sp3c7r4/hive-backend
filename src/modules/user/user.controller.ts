import type { Context } from "hono";
import { formDataToObject, sendSuccessResponse } from "@/helpers";
import { UserService } from "./user.service";
import { SessionRegistryService } from "./session-registry.service";

export class UserController {
	private static instance: UserController;

	private readonly userService: UserService = UserService.getInstance();

	static getInstance() {
		if (!this.instance) {
			this.instance = new UserController();
		}
		return this.instance;
	}

	private constructor() {}

	onboard = async (c: Context) => {
		const authData = c.get("authData");
		const formData = await c.req.formData();

		const data: Record<string, any> = formDataToObject(formData);

		data.avatarUrl = c.get("uploadedFile")?.key;

		const result = await this.userService.onboard(authData, data);

		return sendSuccessResponse(c, {
			message: "Onboarding completed successfully!",
			data: result,
		});
	};

	getProfile = async (c: Context) => {
		const authData = c.get("authData");
		const result = await this.userService.profile(authData);
		return sendSuccessResponse(c, {
			message: "User profile retrieved successfully!",
			user: result,
		});
	};

	updateProfile = async (c: Context) => {
		const authData = c.get("authData");
		const data = await c.req.json();
		const result = await this.userService.update(authData, data);
		return sendSuccessResponse(c, {
			message: "User profile updated successfully!",
			user: result,
		});
	};

	updateAvatar = async (c: Context) => {
		const authData = c.get("authData");
		const { key } = c.get("uploadedFile");
		const result = await this.userService.updateAvatar(authData, key);
		return sendSuccessResponse(c, {
			message: "Avatar updated successfully!",
			user: result,
		});
	};

	updateSignature = async (c: Context) => {
		const authData = c.get("authData");
		const { key } = c.get("uploadedFile");
		const result = await this.userService.updateSignature(authData, key);
		return sendSuccessResponse(c, {
			message: "Signature updated successfully!",
			data: result,
		});
	};

	changePassword = async (c: Context) => {
		const authData = c.get("authData");
		const { currentPassword, newPassword } = await c.req.json();
		await this.userService.updatePassword(
			authData,
			currentPassword,
			newPassword,
		);
		return sendSuccessResponse(c, {
			message: "Password changed successfully!",
		});
	};

	deleteAccount = async (c: Context) => {
		const authData = c.get("authData");
		await this.userService.deleteAccount(authData);
		return sendSuccessResponse(c, {
			message: "Account deleted successfully!",
		});
	};

	listSessions = async (c: Context) => {
		const authData = c.get("authData");
		const sessions = await SessionRegistryService.getInstance().listForUser(
			Number(authData.id),
			authData.authId,
		);
		return sendSuccessResponse(c, { sessions });
	};

	revokeSession = async (c: Context) => {
		const authData = c.get("authData");
		const refreshId = decodeURIComponent(c.req.param("refreshId"));
		const revoked = await SessionRegistryService.getInstance().revoke(
			Number(authData.id),
			refreshId,
		);
		if (!revoked) {
			return sendSuccessResponse(c, { revoked: false });
		}
		return sendSuccessResponse(c, { revoked: true });
	};

}
