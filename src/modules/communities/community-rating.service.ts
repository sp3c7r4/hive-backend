import { and, avg, count, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import { withTransaction } from "@/helpers/db.helper";
import {
	throwBadRequestError,
	throwNotFoundError,
} from "@/helpers/errors/throw-errors";
import { withPresignedUrl } from "@/helpers/storage.helper";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { communities } from "./community.model";
import { communityRatings } from "./community-rating.model";
import { users } from "@/modules/user/user.model";
import { CommunityRepository } from "./community.repository";

/** @info - Community ratings: member-only 1-5 stars, one per user, upserted. */
export class CommunityRatingService {
	private static instance: CommunityRatingService;
	private readonly communityRepo = CommunityRepository.getInstance();

	static getInstance(): CommunityRatingService {
		if (!this.instance) this.instance = new CommunityRatingService();
		return this.instance;
	}

	private constructor() {}

	private resolveCommunity = async (slug: string) => {
		const community = await this.communityRepo.findOne(
			eq(this.communityRepo.getModel().slug as any, slug),
		);
		if (!community) throwNotFoundError("Community not found");
		return community!;
	};

	/** @info - Recompute + persist the aggregate on the communities row. */
	private refreshAggregate = async (communityId: number) => {
		const db = getDb();
		const [row] = await db
			.select({ value: avg(communityRatings.rating), total: count() })
			.from(communityRatings)
			.where(eq(communityRatings.communityId, communityId));
		const average = row?.value ? Math.round(Number(row.value)) : 0;
		const reviewCount = Number(row?.total ?? 0);
		await db
			.update(communities)
			.set({ averageRating: average, reviewCount })
			.where(eq(communities.id, communityId));
		return { average, reviewCount };
	};

	/** @info - Member rates the community (upsert). */
	rate = async (authData: IAuthData, slug: string, rating: number) => {
		if (!Number.isInteger(rating) || rating < 1 || rating > 5)
			throwBadRequestError("Rating must be between 1 and 5");
		const community = await this.resolveCommunity(slug);
		const userId = Number(authData.id);

		await withTransaction(async (tx) => {
			await tx
				.insert(communityRatings)
				.values({ communityId: community.id, userId, rating })
				.onConflictDoUpdate({
					target: [communityRatings.communityId, communityRatings.userId],
					set: { rating, updatedAt: new Date() },
				});
		});

		const { average, reviewCount } = await this.refreshAggregate(community.id);
		return { myRating: rating, average, reviewCount };
	};

	/** @info - Ratings list + aggregate + caller's own rating. */
	list = async (authData: IAuthData, slug: string) => {
		const community = await this.resolveCommunity(slug);
		const userId = Number(authData.id);
		const db = getDb();

		const rows = await db
			.select({
				id: communityRatings.id,
				rating: communityRatings.rating,
				createdAt: communityRatings.createdAt,
				firstName: users.firstName,
				lastName: users.lastName,
				avatarUrl: users.avatarUrl,
			})
			.from(communityRatings)
			.innerJoin(users, eq(communityRatings.userId, users.id))
			.where(eq(communityRatings.communityId, community.id))
			.orderBy(desc(communityRatings.createdAt))
			.limit(50);

		const [mine] = await db
			.select({ rating: communityRatings.rating })
			.from(communityRatings)
			.where(
				and(
					eq(communityRatings.communityId, community.id),
					eq(communityRatings.userId, userId),
				),
			)
			.limit(1);

		return {
			items: rows.map((r) => ({
				id: r.id,
				rating: r.rating,
				createdAt: r.createdAt,
				user: {
					name: `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim(),
					avatarUrl: r.avatarUrl ? withPresignedUrl({ avatarUrl: r.avatarUrl }, "avatarUrl").avatarUrl : null,
				},
			})),
			average: community.averageRating,
			reviewCount: community.reviewCount,
			myRating: mine?.rating ?? null,
		};
	};
}
