import type { Types } from "mongoose";
import type { AuthMethods } from "@/enums";

export interface IUserCredential {
	userId: Types.ObjectId; // ref → User.id

	provider: AuthMethods;
	providerAccountId: string; // Google sub, Facebook ID, Apple ID — immutable, unique per provider

	tokens: IUserCredentialTokens;

	createdAt: Date;
	updatedAt: Date;
}

export interface IUserCredentialTokens {
	accessToken: string;
	refreshToken?: string;
	idToken?: string;
	expiryDate?: Date;
	scope?: string;
	tokenType?: string;
}
