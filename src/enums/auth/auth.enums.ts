export enum UserTypes {
	ADMIN = "admin",
	USER = "user",
}

export enum AuthMethods {
	EMAIL = "email",
	GOOGLE = "google",
	FACEBOOK = "facebook",
	GITHUB = "github",
}

export enum OAuthProviders {
	GOOGLE = "google",
	FACEBOOK = "facebook",
	APPLE = "apple",
}

export enum AuthLoginTypes {
	PASSWORD = "password",
	OTP = "otp",
}

export enum JwtAction {
	VERIFY_EMAIL = "verify_email",
	FORGOT_PASSWORD = "forgot_password",
	AUTHENTICATE = "authenticate",
}

export enum OAuthAction {
	LOGIN = "login",
	SIGNUP = "signup",
}
