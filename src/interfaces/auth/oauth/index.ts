import type { OAuthAction, UserTypes } from "@/enums/auth/auth.enums";

export * from "./apple";
export * from "./facebook";
export * from "./github";
export * from "./google";

export interface IBaseOAuthService {
	authenticate: () => Promise<void>;
	signup: () => Promise<void>;
	login: () => Promise<void>;
	getAccessToken: () => Promise<void>;
	refreshToken: () => Promise<void>;
	revokeAccessToken: () => Promise<void>;
	revokeRefreshToken: () => Promise<void>;
	validateAccessToken: () => Promise<void>;
	validateRefreshToken: () => Promise<void>;
	getUserInfo: () => Promise<void>;
	getUserInfoFromAccessToken: () => Promise<void>;
}

export interface IOauthAuthenticateData {
	userType: UserTypes;
	action: OAuthAction;
}

export interface IOauthCallbackData {
	code: string;
	state: string;
}
