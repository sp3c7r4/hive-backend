import { eq, count, sql, sum } from "drizzle-orm";
import { throwNotFoundError } from "@/helpers/errors/throw-errors";
import { PaginationService } from "@/services/pagination.service";
import { serviceLogger } from "@/utils";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { CommunityMessages } from "./community.message";
import { communities } from "./community.model";
import { CommunityRepository } from "./community.repository";
import type { NewCommunity } from "./community.model";
import { enrollments } from "@/modules/enrollments/enrollment.model";
import { courses } from "@/modules/courses/course.model";
import { getDb } from "@/db/postgres.db";

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

	/* Analytics */

	analytics = async (slug: string, params?: { from?: string; to?: string }) => {
		const db = getDb();

		/* Find community by slug first */
		const community = await this.repo.findOne(
			eq(this.repo.getModel().slug as any, slug),
		);
		if (!community) throwNotFoundError(CommunityMessages.NOT_FOUND);

		/* Course enrollments per course */
		const courseEnrollments = await db
			.select({
				courseId: courses.id,
				courseTitle: courses.title,
				count: count(enrollments.id),
			})
			.from(courses)
			.leftJoin(enrollments, eq(enrollments.courseId, courses.id))
			.where(eq(courses.communityId, community!.id))
			.groupBy(courses.id, courses.title);

		/* Active members (enrollments in community courses) */
		const activeResult = await db
			.select({ value: count(enrollments.id) })
			.from(enrollments)
			.innerJoin(courses, eq(enrollments.courseId, courses.id))
			.where(eq(courses.communityId, community!.id));
		const activeMembers = Number(activeResult[0]?.value ?? 0);

		/* Revenue (sum of course prices × enrollment counts) */
		const revResult = await db
			.select({
				rev: sql<number>`COALESCE(SUM(${courses.price} * ${courses.enrollmentCount}), 0)`,
			})
			.from(courses)
			.where(eq(courses.communityId, community!.id));
		const revenue = Number(revResult[0]?.rev ?? 0);

		return {
			community: { id: community!.id, name: community!.name, slug: community!.slug },
			courseEnrollments,
			activeMembers,
			revenue,
		};
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
