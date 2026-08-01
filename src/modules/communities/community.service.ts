import { eq } from "drizzle-orm";
import { throwNotFoundError } from "@/helpers/errors/throw-errors";
import { PaginationService } from "@/services/pagination.service";
import { serviceLogger } from "@/utils";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { CommunityMessages } from "./community.message";
import { communities } from "./community.model";
import { CommunityRepository } from "./community.repository";
import type { NewCommunity } from "./community.model";

export class CommunityService {
	private static instance: CommunityService;
	private repo: CommunityRepository;

	/** @info - Services */
	private paginationService: PaginationService<typeof communities>;

	/** @info - Utilities */
	private readonly log = serviceLogger("Community");

	static getInstance(): CommunityService {
		if (!this.instance) this.instance = new CommunityService();
		return this.instance;
	}

	private constructor() {
		this.repo = CommunityRepository.getInstance();
		this.paginationService = new PaginationService(communities);
	}

	create = async (authData: IAuthData, data: NewCommunity) => {
		const slug = this._slugify(data.name, authData.id);
		return this.repo.create({ ...data, slug, ownerId: authData.id } as any);
	};

	getById = async (id: number) => {
		return this.repo.findById(id);
	};

	getBySlug = async (slug: string) => {
		const community = await this.repo.findOne(
			eq(this.repo.getModel().slug as any, slug),
		);
		return community ?? throwNotFoundError(CommunityMessages.NOT_FOUND);
	};

	list = async (params?: { page?: number; limit?: number }) => {
		return this.paginationService.paginate({
			page: params?.page ?? 1,
			limit: params?.limit ?? 20,
		});
	};

	update = async (id: number, data: Partial<NewCommunity>) => {
		const community = await this.repo.update(id, data as any);
		return community ?? throwNotFoundError(CommunityMessages.NOT_FOUND);
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
