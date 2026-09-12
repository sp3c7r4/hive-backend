import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { DbClient } from "@/bases";
import { getDb } from "@/db/postgres.db";
import {
	throwBadRequestError,
	throwForbiddenError,
	throwNotFoundError,
} from "@/helpers/errors/throw-errors";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { CommunityMessages } from "./community.message";
import { communities, communityMembers } from "./community.model";

/**
 * @info - The single definition of "communities this user may publish a course
 * into": the community they own, or one they are an active member of.
 *
 * `community.service.list` builds its scope=mine listing from this exact
 * expression — the list the create flow offers as publish targets — and the
 * course create/move paths assert against it, so the set the UI offers and the
 * set the API accepts cannot drift apart.
 */
export const publishableCommunitiesWhere = (db: DbClient, userId: number) => {
	const activeMemberOf = db
		.select({ communityId: communityMembers.communityId })
		.from(communityMembers)
		.where(
			and(
				eq(communityMembers.userId, userId),
				eq(communityMembers.status, "active"),
			),
		);

	/* @info - An owner keeps their own soft-deleted communities in the list
	 * (they still manage them); a joined member loses one once it is deleted. */
	return and(
		or(
			eq(communities.ownerId, userId),
			inArray(communities.id, activeMemberOf),
		),
		or(isNull(communities.deletedAt), eq(communities.ownerId, userId)),
	)!;
};

/** @info - Refusal message for a live community the caller cannot publish into. */
export const PUBLISH_TARGET_DENIED =
	"You can only publish a course into a community you own or belong to.";

/**
 * @info - Rejects unless `communityId` is a community the caller may publish
 * into, so a course can never be handed to a community the caller has no
 * standing in.
 *
 * An unknown or archived community is a 404 (an archived community must read as
 * absent rather than as a permission problem); a live community the caller
 * cannot publish into is a 403. Platform admins bypass the membership test but
 * still need a live community to exist.
 *
 * The accepted path costs a single query: membership is proven by the same
 * where-expression the scope=mine list uses, and only a refusal pays for the
 * second lookup that separates "does not exist" from "not yours".
 */
export const assertPublishTarget = async (
	authData: IAuthData | undefined,
	communityId: number,
): Promise<void> => {
	if (!Number.isInteger(communityId) || communityId <= 0) {
		throwBadRequestError("A valid community is required.");
	}

	const db = getDb();
	const userId = Number(authData?.id);
	const isAdmin =
		Array.isArray(authData?.roles) &&
		(authData as any).roles.includes("admin");

	if (!isAdmin && userId) {
		const [allowed] = await db
			.select({ id: communities.id })
			.from(communities)
			.where(
				and(
					eq(communities.id, communityId),
					isNull(communities.deletedAt),
					publishableCommunitiesWhere(db, userId),
				),
			)
			.limit(1);
		if (allowed) return;
	}

	/* @info - Refusal path: separate "no such live community" from "not yours". */
	const [target] = await db
		.select({ id: communities.id })
		.from(communities)
		.where(and(eq(communities.id, communityId), isNull(communities.deletedAt)))
		.limit(1);
	if (!target) throwNotFoundError(CommunityMessages.NOT_FOUND);
	if (isAdmin) return;

	throwForbiddenError(PUBLISH_TARGET_DENIED);
};
