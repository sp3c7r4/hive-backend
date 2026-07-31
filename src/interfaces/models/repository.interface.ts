import type { Document, Types } from "mongoose";

export interface Repository extends Document<Types.ObjectId> {
	/** @info- Basic */
	name: string;
	description: string;
	default_branch: string;
	language: string;
	private: boolean;
	fullName: string;

	/** @info - Initialized */
	initialized: boolean;
	backedUp: boolean;
	url: string;
	version: number;
}
