import { eq } from "drizzle-orm";
import { CommunityRepository } from "./community.repository";
import type { NewCommunity } from "./community.model";

export class CommunityService {
	private static instance: CommunityService;

	private readonly repo: CommunityRepository;

	static getInstance(): CommunityService {
		if (!this.instance) this.instance = new CommunityService();
		return this.instance;
	}

	private constructor() {
		this.repo = CommunityRepository.getInstance();
	}

	create = async (data: NewCommunity & { ownerId: number }) => {
		const slug = this._slugify(data.name, data.ownerId);

		return this.repo.create({ ...data, slug } as any);
	};

	getById = async (id: number) => {
		return this.repo.findById(id);
	};

	getBySlug = async (slug: string) => {
		return this.repo.findOne(eq(this.repo.getModel().slug as any, slug));
	};

	list = async (page = 1, limit = 20) => {
		return this.repo.findPaginated(page, limit);
	};

	update = async (id: number, data: Partial<NewCommunity>) => {
		return this.repo.update(id, data as any);
	};

	delete = async (id: number) => {
		return this.repo.softDelete(id);
	};

	private _slugify = (name: string, ownerId: number): string => {
		const base = name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "");
		const suffix = ownerId.toString(36).slice(-4);
		return `${base}-${suffix}`;
	};
}
