import { eq, and, or, isNull, inArray, count, sql } from "drizzle-orm";
import { throwNotFoundError, throwBadRequestError } from "@/helpers/errors/throw-errors";
import { PaginationService } from "@/services/pagination.service";
import { serviceLogger } from "@/utils";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { CommunityMessages } from "./community.message";
import { communities, communityMembers } from "./community.model";
import { users } from "@/modules/user/user.model";
import { CommunityRepository } from "./community.repository";
import type { NewCommunity } from "./community.model";
import { enrollments } from "@/modules/enrollments/enrollment.model";
import { courses } from "@/modules/courses/course.model";
import { payments } from "@/modules/payment/payment.model";
import { getDb } from "@/db/postgres.db";
import { withPresignedUrl, withTransaction } from "@/helpers";
import { RelationalRepository } from "@/bases";

/** @info - Map drizzle's camelCase timestamps to the API contract (handles both raw
 *          rows with camelCase `createdAt` and legacy snake_case rows) */
export const toCommunityDto = <T extends Record<string, any>>(community: T) => {
	const { created_at, updated_at, ...rest } = community;
	return {
		...rest,
		createdAt: created_at ?? rest.createdAt ?? null,
		updatedAt: updated_at ?? rest.updatedAt ?? null,
	};
};

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
		const db = getDb();
		const slug = await this._uniqueSlug(data.name, authData.id);

    const createdCommunity = await withTransaction(async (tx) => {
      const communityRepo = new RelationalRepository(communities, tx);
      const communityMembersRepo = new RelationalRepository(communityMembers, tx);

      const community = await communityRepo.create({ ...data, slug, ownerId: authData.id, memberCount: 1 } as any);

  		/* Auto-add the creator as the owner member */
  		const existing = await db
  			.select({ id: communityMembers.id })
  			.from(communityMembers)
  			.where(
  				and(
  					eq(communityMembers.communityId, community!.id),
  					eq(communityMembers.userId, authData.id),
  				),
  			)
  			.limit(1);

  		if (existing.length === 0) {
  			await communityMembersRepo.create({
  				communityId: community!.id,
  				userId: authData.id,
  				role: "instructor" as any,
  				memberRole: "owner" as any,
  				status: "active" as any,
  			});
      }

      return community;
    })


		return toCommunityDto(withPresignedUrl(createdCommunity, "coverImageUrl"));
	};

	getById = async (id: number) => {
		return this.repo.findById(id);
	};

	getBySlug = async (slug: string, authData?: IAuthData) => {
		/* includeDeleted: owners must be able to open their archived communities */
		const community = await this.repo.findOne(
			eq(this.repo.getModel().slug as any, slug),
			{ includeDeleted: true },
		);
		if (!community) throwNotFoundError(CommunityMessages.NOT_FOUND);

		/* Archived communities are only visible to their owner */
		if ((community as any).deletedAt && (community as any).ownerId !== authData?.id) {
			throwNotFoundError(CommunityMessages.NOT_FOUND);
		}

		const db = getDb();
		const [owner] = await db
			.select({ firstName: users.firstName, lastName: users.lastName, avatarUrl: users.avatarUrl })
			.from(users)
			.where(eq(users.id, community!.ownerId))
			.limit(1);

		/* @info - Real membership state for the authenticated visitor (join page) */
		let membership: "active" | "pending" | "none" = "none";
		if (authData?.id) {
			const [member] = await db
				.select({ status: communityMembers.status })
				.from(communityMembers)
				.where(
					and(
						eq(communityMembers.communityId, community!.id),
						eq(communityMembers.userId, Number(authData.id)),
					),
				)
				.limit(1);
			membership = member ? (member.status === "pending" ? "pending" : "active") : "none";
		}

		return {
			...toCommunityDto(withPresignedUrl(community!, "coverImageUrl")),
			owner: owner
				? {
						name: `${owner.firstName ?? ""} ${owner.lastName ?? ""}`.trim(),
						avatarUrl: owner.avatarUrl ? withPresignedUrl(owner, "avatarUrl").avatarUrl : null,
					}
				: null,
			membership,
		};
	};

	list = async (params?: { page?: number; limit?: number; userId?: number; scope?: "mine" | "owned" }) => {
		const db = getDb();

		let where: any;
		if (params?.scope === "owned" && params.userId) {
			/* Owned only — used by the instructor Members filter dropdown (excludes joined-only) */
			where = and(eq(communities.ownerId, params.userId), isNull(communities.deletedAt));
		} else if (params?.scope === "mine" && params.userId) {
			/* My Communities: owned OR actively a member of. Owner's archived ones included. */
			const memberIds = db
				.select({ communityId: communityMembers.communityId })
				.from(communityMembers)
				.where(
					and(
						eq(communityMembers.userId, params.userId),
						eq(communityMembers.status, "active"),
					),
				);
			where = and(
				or(eq(communities.ownerId, params.userId), inArray(communities.id, memberIds)),
				or(isNull(communities.deletedAt), eq(communities.ownerId, params.userId)),
			);
		} else {
			/* Explore: public + live communities only */
			where = and(
				isNull(communities.deletedAt),
				eq(communities.visibility, "public"),
			);
		}

		const result = await this.paginationService.paginate({
			page: params?.page ?? 1,
			limit: params?.limit ?? 20,
			where,
		});

		return { ...result, data: result.data.map((c) => toCommunityDto(withPresignedUrl(c, "coverImageUrl"))) };
	};

	update = async (id: number, data: Partial<NewCommunity>) => {
		const community = await this.repo.update(id, data as any);
		if (!community) throwNotFoundError(CommunityMessages.NOT_FOUND);
		return toCommunityDto(withPresignedUrl(community!, "coverImageUrl"));
	};

	delete = async (id: number, permanent = false): Promise<void> => {
		if (!permanent) {
			const community = await this.repo.softDelete(id);
			if (!community) throwNotFoundError(CommunityMessages.NOT_FOUND);
			this.log.info(`Community ${id} soft-deleted`);
			return;
		}

		/* Permanent delete — DB cascades members/invites/feed, but courses and
		 * payments reference the community with restrict/no-action. */
		const db = getDb();
		const community = await this.repo.findById(id, { includeDeleted: true });
		if (!community) throwNotFoundError(CommunityMessages.NOT_FOUND);

		const [courseRows] = await db
			.select({ value: count() })
			.from(courses)
			.where(eq(courses.communityId, id));
		if (Number(courseRows?.value ?? 0) > 0) {
			throwBadRequestError(
				"Cannot permanently delete this community: it has courses. Delete or move the courses first.",
			);
		}

		const [paymentRows] = await db
			.select({ value: count() })
			.from(payments)
			.where(eq(payments.communityId, id));
		if (Number(paymentRows?.value ?? 0) > 0) {
			throwBadRequestError(
				"Cannot permanently delete this community: payment records exist.",
			);
		}

		await db.delete(communities).where(eq(communities.id, id));
		this.log.info(`Community ${id} permanently deleted`);
	};

	restore = async (id: number) => {
		const community = await this.repo.update(id, { deletedAt: null } as any, { includeDeleted: true });
		if (!community) throwNotFoundError(CommunityMessages.NOT_FOUND);
		this.log.info(`Community ${id} unarchived`);
		return toCommunityDto(withPresignedUrl(community!, "coverImageUrl"));
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

	private _uniqueSlug = async (
		name: string,
		ownerId: number,
	): Promise<string> => {
		const base = this._slugify(name, ownerId);

		/* Check if slug already exists */
		const existing = await this.repo.findOne(
			eq(this.repo.getModel().slug as any, base),
		);
		if (!existing) return base;

		/* Collision — append a random 4-char suffix until unique */
		for (let i = 0; i < 5; i++) {
			const rand = Math.random().toString(36).slice(2, 6);
			const candidate = `${base}-${rand}`;
			const dup = await this.repo.findOne(
				eq(this.repo.getModel().slug as any, candidate),
			);
			if (!dup) return candidate;
		}

		/* Extremely unlikely — fallback to timestamp */
		return `${base}-${Date.now().toString(36)}`;
	};
}
