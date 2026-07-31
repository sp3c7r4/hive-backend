import type { Types } from "mongoose";
import type { ConnectionPlatform } from "@/enums";

export interface IContact {
	platform: ConnectionPlatform; // where they reached you from
	platformUserId: string; // their ID on that channel (phone number, IG handle, etc.)

	displayName?: string;
	firstName?: string;
	lastName?: string;
	email?: string;
	phone?: string;
	avatar?: string;

	metadata?: Record<string, any>; // e.g. { preferredSize: "M", city: "Lagos" }

	createdAt: Date;
	updatedAt: Date;
}

/** @info- Unique Bridge one business to one contact */
export interface IContactBusiness {
	businessId: Types.ObjectId;
	contactId: Types.ObjectId;

	isBlocked: boolean;

	tags?: string[];

	createdAt: Date;
	updatedAt: Date;
}
