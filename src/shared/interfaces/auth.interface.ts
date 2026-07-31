import type { AuthLoginTypes } from "@/enums";

export interface SignupData {
	firstName: string;
	lastName: string;
	email: string;
	password: string;
}

export interface LoginData {
	email: string;
	password: string;
	loginType: AuthLoginTypes;
}

export interface ISignupDataWithMetadata extends SignupData {
	ipAddress: string;
	location: string;
	userAgent: string;
	userType: string;
}

export interface ILoginDataWithMetadata extends LoginData {
	ipAddress: string;
	location: string;
	userAgent: string;
	userType: string;
}
