import type { Document, Types } from "mongoose";

export interface ITelegramSession extends Document<Types.ObjectId> {
	connectionId: Types.ObjectId;
	sessionString: string;
}
