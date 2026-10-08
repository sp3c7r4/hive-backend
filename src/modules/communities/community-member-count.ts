import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import { communityMembers } from "./community.model";

/**
 * @info - Real active member counts.
 *
 * `communities.member_count` is written once, as 1, when the community is created and never
 * maintained, so every screen reading it claims a community of 72 has one member. This is
 * the single definition of the real count, so the overview, the listing and the join page
 * cannot drift apart.
 *
 * Pending members do not count. One query per page, over a single table, no joins.
 * See 2026-10-08-counts-locked-curriculum-bulk-invite-design.md.
 */
export const countActiveMembers = async (
	communityIds: number[],
): Promise<Map<number, number>> => {
	const ids = [...new Set(communityIds.filter((id) => Number.isFinite(id)))];
	if (ids.length === 0) return new Map();

	const rows = await getDb()
		.select({
			communityId: communityMembers.communityId,
			total: sql<number>`count(*)::int`,
		})
		.from(communityMembers)
		.where(
			and(
				inArray(communityMembers.communityId, ids),
				eq(communityMembers.status, "active"),
			),
		)
		.groupBy(communityMembers.communityId);

	return new Map(
		rows.map((row) => [Number(row.communityId), Number(row.total)]),
	);
};

/** @info - The same read for one community row, with `memberCount` replaced by the real one. */
export const withActiveMemberCount = async <T extends { id: number }>(
	row: T,
): Promise<T & { memberCount: number }> => {
	const counts = await countActiveMembers([Number(row.id)]);
	return { ...row, memberCount: counts.get(Number(row.id)) ?? 0 };
};
