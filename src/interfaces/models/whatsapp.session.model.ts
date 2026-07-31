import type { Document, Types } from "mongoose";

export interface IwhatsappSession extends Document<Types.ObjectId> {
	connectionId: Types.ObjectId;
	key: string;
	data: string; // JSON serialized
}
