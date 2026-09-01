import { eq, and } from "drizzle-orm";
import type { Context, Next } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendErrorResponse } from "@/helpers/response/send-response";
import { getDb } from "@/db/postgres.db";
import { communities, communityMembers } from "@/modules/communities/community.model";

/**
 * @info - Require the authenticated user to be a member of the community
 *         identified by the :slug route parameter. Sets `community` and
 *         `communityMember` on context for downstream handlers.
 */
export const requireCommunityMember = async (c: Context, next: Next) => {
	const authData = c.get("authData");
	if (!authData?.id) {
		return sendErrorResponse(
			c,
			{ message: "Authentication required." },
			StatusCodes.UNAUTHORIZED,
		);
	}

	const slug = c.req.param("slug");
	if (!slug) {
		return sendErrorResponse(
			c,
			{ message: "Community slug is required." },
			StatusCodes.BAD_REQUEST,
		);
	}

	const db = getDb();

	const [community] = await db
		.select({ id: communities.id, slug: communities.slug })
		.from(communities)
		.where(eq(communities.slug, slug))
		.limit(1);

	if (!community) {
		return sendErrorResponse(
			c,
			{ message: "Community not found." },
			StatusCodes.NOT_FOUND,
		);
	}

	const [member] = await db
		.select()
		.from(communityMembers)
		.where(
			and(
				eq(communityMembers.communityId, community.id),
				eq(communityMembers.userId, Number(authData.id)),
			),
		)
		.limit(1);

	if (!member) {
		return sendErrorResponse(
			c,
			{ message: "You must be a member of this community." },
			StatusCodes.FORBIDDEN,
		);
	}

	/* Blocked members have no access — membership row existence is not enough */
	if (member.status === "blocked") {
		return sendErrorResponse(
			c,
			{ message: "Your membership is blocked. Contact a community admin." },
			StatusCodes.FORBIDDEN,
		);
	}

	c.set("community", community);
	c.set("communityMember", member);

	await next();
};

/**
 * @info - Read-only variant: platform admins may view a community's
 *         feed/ratings/members without being a member. Writes stay
 *         member-gated via requireCommunityMember.
 */
export const requireCommunityMemberOrAdmin = async (c: Context, next: Next) => {
	const authData = c.get("authData");
	if (!authData?.id) {
		return sendErrorResponse(
			c,
			{ message: "Authentication required." },
			StatusCodes.UNAUTHORIZED,
		);
	}

	const isPlatformAdmin =
		Array.isArray(authData.roles) && (authData as any).roles.includes("admin");

	const slug = c.req.param("slug");
	if (!slug) {
		return sendErrorResponse(
			c,
			{ message: "Community slug is required." },
			StatusCodes.BAD_REQUEST,
		);
	}

	const db = getDb();

	const [community] = await db
		.select({ id: communities.id, slug: communities.slug })
		.from(communities)
		.where(eq(communities.slug, slug))
		.limit(1);

	if (!community) {
		return sendErrorResponse(
			c,
			{ message: "Community not found." },
			StatusCodes.NOT_FOUND,
		);
	}

	const [member] = await db
		.select()
		.from(communityMembers)
		.where(
			and(
				eq(communityMembers.communityId, community.id),
				eq(communityMembers.userId, Number(authData.id)),
			),
		)
		.limit(1);

	/* Platform admins bypass the membership gate for read access */
	if (!member && !isPlatformAdmin) {
		return sendErrorResponse(
			c,
			{ message: "You must be a member of this community." },
			StatusCodes.FORBIDDEN,
		);
	}

	if (member?.status === "blocked" && !isPlatformAdmin) {
		return sendErrorResponse(
			c,
			{ message: "Your membership is blocked. Contact a community admin." },
			StatusCodes.FORBIDDEN,
		);
	}

	c.set("community", community);
	if (member) c.set("communityMember", member);

	await next();
};

/**
 * @info - Require the authenticated user to be an owner or admin of
 *         the community identified by the :slug route parameter.
 *         Implies requireCommunityMember.
 */
export const requireCommunityAdmin = async (c: Context, next: Next) => {
	const authData = c.get("authData");
	if (!authData?.id) {
		return sendErrorResponse(
			c,
			{ message: "Authentication required." },
			StatusCodes.UNAUTHORIZED,
		);
	}

	const slug = c.req.param("slug");
	if (!slug) {
		return sendErrorResponse(
			c,
			{ message: "Community slug is required." },
			StatusCodes.BAD_REQUEST,
		);
	}

	const db = getDb();

	const [community] = await db
		.select({ id: communities.id, slug: communities.slug })
		.from(communities)
		.where(eq(communities.slug, slug))
		.limit(1);

	if (!community) {
		return sendErrorResponse(
			c,
			{ message: "Community not found." },
			StatusCodes.NOT_FOUND,
		);
	}

	const [member] = await db
		.select()
		.from(communityMembers)
		.where(
			and(
				eq(communityMembers.communityId, community.id),
				eq(communityMembers.userId, Number(authData.id)),
			),
		)
		.limit(1);

	if (!member) {
		return sendErrorResponse(
			c,
			{ message: "Admin access required." },
			StatusCodes.FORBIDDEN,
		);
	}

	if (member.memberRole !== "owner" && member.memberRole !== "admin") {
		return sendErrorResponse(
			c,
			{ message: "Admin access required." },
			StatusCodes.FORBIDDEN,
		);
	}

	/* A blocked admin cannot manage the community */
	if (member.status === "blocked") {
		return sendErrorResponse(
			c,
			{ message: "Your membership is blocked. Contact a community admin." },
			StatusCodes.FORBIDDEN,
		);
	}

	c.set("community", community);
	c.set("communityMember", member);

	await next();
};
