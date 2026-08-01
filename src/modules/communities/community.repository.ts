import { RelationalRepository } from "@/bases";
import { communities } from "./community.model";

export class CommunityRepository extends RelationalRepository<typeof communities> {
	private static instance: CommunityRepository | null;

	static getInstance(): CommunityRepository {
		if (!this.instance) this.instance = new CommunityRepository();
		return this.instance;
	}

	private constructor() {
		super(communities);
	}
}
