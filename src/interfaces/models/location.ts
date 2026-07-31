import type { Document, Types } from "mongoose";
import type { CoordinateEnums } from "@/enums";

export interface ILocation extends Document<Types.ObjectId> {
	address?: string;
	city?: string;
	state?: string;
	country?: string;
	zipCode?: string;
	coordinates?: {
		type: CoordinateEnums;
		coordinates: [number, number];
	};
}
