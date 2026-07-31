import type { JwtAction, UserTypes } from "@/enums";
import type { IBaseUser } from "../models";

export interface IAuthData {
	authId: string;
	action: JwtAction;
	userType: UserTypes;

	otpId?: string;
	firstName?: string;
	lastName?: string;
	email?: string;
	password?: string;

	// Authenticated data
	isAuthenticated?: boolean;
	authenticatedAt?: Date;

	// Rest
	[key: string]: any;
}

export interface IJwtPayload {
	authId: string;
	action: JwtAction;
	userType: UserTypes;
	[key: string]: any;
}

export interface IAuthenticatedUser extends IBaseUser {
	isAuthenticated: boolean;
	authenticatedAt: Date;
	[key: string]: any;
}

export interface IAuthResponse {
	message: string;
	refreshToken?: string;
	accessToken?: string;
	user?: IAuthenticatedUser;
}
