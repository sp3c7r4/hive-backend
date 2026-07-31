import type { ILocation } from "./location";

export interface IBusiness {
	id: number;
	ownerId: number;
	name: string;
	description: string;
	email: string;
	location: ILocation | null;
	logo?: string;
	website?: string;
	phone?: string;
	industryTags?: string[];
	created_at: Date;
	updated_at: Date;
	deleted_at: Date;
}
