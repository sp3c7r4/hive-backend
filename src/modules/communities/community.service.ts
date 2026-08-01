import { eq } from "drizzle-orm";
import { throwNotFoundError } from "@/helpers/errors/throw-errors";
import { PaginationService } from "@/services/pagination.service";
import { serviceLogger } from "@/utils";
import { CommunityMessages } from "./community.message";
import { communities } from "./community.model";
import { CommunityRepository } from "./community.repository";
import type { NewCommunity } from "./community.model";

export class CommunityService {
	private static instance: CommunityService | null;

	/** @info - Repositories */
	private readonly repo: CommunityRepository;
	/** @info - Services */
	private readonly paginationService = new PaginationService<typeof communities>(communities);
	/** @info - Utilities */
	private readonly log = serviceLogger("Community");

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
		const community = await this.repo.findOne(
			eq(this.repo.getModel().slug as any, slug),
		);
		if (!community) throwNotFoundError(CommunityMessages.NOT_FOUND);
		return community;
	};

	list = async (params?: { page?: number; limit?: number }) => {
		return this.paginationService.paginate({
			page: params?.page ?? 1,
			limit: params?.limit ?? 20,
		});
	};

	update = async (id: number, data: Partial<NewCommunity>) => {
		const community = await this.repo.update(id, data as any);
		if (!community) throwNotFoundError(CommunityMessages.NOT_FOUND);
		return community;
	};

	delete = async (id: number): Promise<void> => {
		const community = await this.repo.softDelete(id);
		if (!community) throwNotFoundError(CommunityMessages.NOT_FOUND);
		this.log.info(`Community ${id} soft-deleted`);
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
