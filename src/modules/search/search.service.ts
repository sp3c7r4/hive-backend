import { and, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import { courses } from "@/modules/courses/course.model";
import { communities } from "@/modules/communities/community.model";
import { users } from "@/modules/user/user.model";
import { user_roles } from "@/modules/user/user-role.model";
import { withPresignedUrl } from "@/helpers";

/** @info - Global search across courses, communities and users.
 * Simple ILIKE over the main display fields, 10 results per section. */
export class SearchService {
	private static instance: SearchService;

	static getInstance(): SearchService {
		if (!this.instance) this.instance = new SearchService();
		return this.instance;
	}

	private constructor() {}

	search = async (query: string) => {
		const db = getDb();
		const q = query.trim();
		if (!q) return { courses: [], communities: [], users: [] };

		const like = `%${q}%`;

		const [courseRows, communityRows, userRows] = await Promise.all([
			db
				.select({
					id: courses.id,
					title: courses.title,
					slug: courses.slug,
					coverImageUrl: courses.coverImageUrl,
					price: courses.price,
				})
				.from(courses)
				.where(
					and(
						ilike(courses.title, like),
						isNull(courses.deletedAt),
						eq(courses.status as any, "published"),
					),
				)
				.limit(10) as any,
			db
				.select({
					id: communities.id,
					name: communities.name,
					slug: communities.slug,
					coverImageUrl: communities.coverImageUrl,
					visibility: communities.visibility,
				})
				.from(communities)
				.where(
					and(ilike(communities.name, like), isNull(communities.deletedAt)),
				)
				.limit(10) as any,
			db
				.select({
					id: users.id,
					firstName: users.firstName,
					lastName: users.lastName,
					email: users.email,
					avatarUrl: users.avatarUrl,
				})
				.from(users)
				.where(
					and(
						or(
							ilike(users.firstName, like),
							ilike(users.lastName, like),
							ilike(users.email, like),
						),
						isNull(users.deletedAt),
					),
				)
				.limit(10) as any,
		]);

		const ids = (userRows as any[]).map((u) => u.id);
		const roleMap = new Map<number, string[]>();
		if (ids.length) {
			const rows = (await db
				.select({ userId: user_roles.userId, role: user_roles.role })
				.from(user_roles)
				.where(inArray(user_roles.userId, ids))) as any[];
			for (const r of rows) {
				roleMap.set(Number(r.userId), [...(roleMap.get(Number(r.userId)) ?? []), r.role]);
			}
		}

		return {
			courses: (courseRows as any[]).map((c) => ({
				id: c.id,
				title: c.title,
				slug: c.slug,
				price: Number(c.price ?? 0),
				coverImageUrl: c.coverImageUrl
					? withPresignedUrl({ coverImageUrl: c.coverImageUrl }, "coverImageUrl").coverImageUrl
					: null,
			})),
			communities: (communityRows as any[]).map((c) => ({
				id: c.id,
				name: c.name,
				slug: c.slug,
				visibility: c.visibility,
				coverImageUrl: c.coverImageUrl
					? withPresignedUrl({ coverImageUrl: c.coverImageUrl }, "coverImageUrl").coverImageUrl
					: null,
			})),
			users: (userRows as any[]).map((u) => ({
				id: u.id,
				name: `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim(),
				email: u.email,
				roles: roleMap.get(u.id) ?? [],
				avatarUrl: u.avatarUrl
					? withPresignedUrl({ avatarUrl: u.avatarUrl }, "avatarUrl").avatarUrl
					: null,
			})),
		};
	};
}
