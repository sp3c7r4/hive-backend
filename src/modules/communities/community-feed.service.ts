import { eq, and, desc, isNull, sql, inArray } from "drizzle-orm";
import { config } from "@/config";
import { throwNotFoundError, throwBadRequestError } from "@/helpers/errors/throw-errors";
import { withPresignedUrl } from "@/helpers/storage.helper";
import { getDb } from "@/db/postgres.db";
import { PaginationService } from "@/services/pagination.service";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { CommunityRepository } from "./community.repository";
import {
	communityPosts,
	communityPostAttachments,
	communityPostLikes,
	communityPostComments,
} from "./community-feed.model";
import { communityMembers } from "./community.model";
import { users } from "@/modules/user/user.model";
import { user_roles } from "@/modules/user/user-role.model";
import { NotificationService } from "@/modules/notifications";
import { NotificationType } from "@/enums";

const POSTS_PER_PAGE = 20;
const COMMENTS_PER_PAGE = 50;

interface AuthorInfo {
	id: number;
	firstName: string;
	lastName: string;
	avatarUrl: string | null;
	isInstructor: boolean;
}

export class CommunityFeedService {
	private static instance: CommunityFeedService;
	private readonly communityRepo = CommunityRepository.getInstance();

	static getInstance(): CommunityFeedService {
		if (!this.instance) this.instance = new CommunityFeedService();
		return this.instance;
	}

	private constructor() {}

	/* ── Helpers ────────────────────────────────────────────── */

	private async _resolveCommunity(slug: string) {
		const community = await this.communityRepo.findOne(
			eq(this.communityRepo.getModel().slug as any, slug),
		);
		if (!community) throwNotFoundError("Community not found");
		return community!;
	}

	/** Batch-resolve which userIds are instructors */
	private async _resolveInstructors(userIds: number[]): Promise<Set<number>> {
		if (userIds.length === 0) return new Set();
		const db = getDb();
		const rows = await db
			.selectDistinct({ userId: user_roles.userId })
			.from(user_roles)
			.where(
				and(
					inArray(user_roles.userId, userIds),
					eq(user_roles.role, "instructor"),
				),
			);
		return new Set(rows.map((r) => r.userId));
	}

	private _buildAuthor(
		row: Record<string, any>,
		instructorSet: Set<number>,
	): AuthorInfo {
		const uid = Number(row.authorId ?? row.id);
		const rawAvatarUrl = (row.authorAvatarUrl ?? row.avatarUrl ?? null) as string | null;
		return withPresignedUrl({
			id: uid,
			firstName: (row.authorFirstName ?? row.firstName) as string,
			lastName: (row.authorLastName ?? row.lastName) as string,
			avatarUrl: rawAvatarUrl,
			isInstructor: instructorSet.has(uid),
		}, "avatarUrl") as AuthorInfo;
	}

	private _formatPost(
		row: Record<string, any>,
		instructorSet: Set<number>,
		likedSet: Set<number>,
	) {
		const author = this._buildAuthor(row, instructorSet);
		return withPresignedUrl(
			{
				id: row.postId as number,
				communityId: row.communityId as number,
				author,
				content: row.content as string,
				isPinned: row.isPinned as boolean,
				isAnnouncement: row.isAnnouncement as boolean,
				likeCount: row.likeCount as number,
				commentCount: row.commentCount as number,
				likedByUser: likedSet.has(row.postId as number),
				createdAt: row.postCreatedAt as unknown as string,
				editedAt:
					(row.postUpdatedAt as unknown as string) !== (row.postCreatedAt as unknown as string)
						? (row.postUpdatedAt as unknown as string)
						: null,
				attachments: [] as { filename: string; s3Key: string }[],
			},
			"avatarUrl",
		);
	}

	/* ── Posts ───────────────────────────────────────────────── */

	listPosts = async (
		authData: IAuthData,
		slug: string,
		params?: { page?: number; limit?: number },
	) => {
		const community = await this._resolveCommunity(slug);
		const db = getDb();
		const userId = Number(authData.id);
		const page = params?.page ?? 1;
		const limit = params?.limit ?? POSTS_PER_PAGE;

		/* Fetch posts with author info */
		const rows = await db
			.select({
				postId: communityPosts.id,
				communityId: communityPosts.communityId,
				content: communityPosts.content,
				isPinned: communityPosts.isPinned,
				isAnnouncement: communityPosts.isAnnouncement,
				likeCount: communityPosts.likeCount,
				commentCount: communityPosts.commentCount,
				postCreatedAt: communityPosts.createdAt,
				postUpdatedAt: communityPosts.updatedAt,
				authorId: users.id,
				authorFirstName: users.firstName,
				authorLastName: users.lastName,
				authorAvatarUrl: users.avatarUrl,
			})
			.from(communityPosts)
			.innerJoin(users, eq(communityPosts.authorId, users.id))
			.where(and(
				eq(communityPosts.communityId, community.id),
				isNull(communityPosts.deletedAt),
			))
			.orderBy(
				desc(communityPosts.isPinned),
				desc(communityPosts.isAnnouncement),
				desc(communityPosts.createdAt),
			)
			.limit(limit)
			.offset((page - 1) * limit);

		/* Total count */
		const [countRow] = await db
			.select({ total: sql<number>`count(*)::int` })
			.from(communityPosts)
			.where(and(
				eq(communityPosts.communityId, community.id),
				isNull(communityPosts.deletedAt),
			));

		/* Batch: which posts did current user like? */
		const postIds = rows.map((r) => r.postId);
		let likedSet = new Set<number>();
		if (postIds.length > 0) {
			const likes = await db
				.select({ postId: communityPostLikes.postId })
				.from(communityPostLikes)
				.where(
					and(
						inArray(communityPostLikes.postId, postIds),
						eq(communityPostLikes.userId, userId),
					),
				);
			likedSet = new Set(likes.map((l) => l.postId));
		}

		/* Batch: which authors are instructors? */
		const authorIds = [...new Set(rows.map((r) => r.authorId as number))];
		const instructorSet = await this._resolveInstructors(authorIds);

		/* Batch: attachments for these posts */
		let attachmentMap = new Map<number, { filename: string; s3Key: string; url: string }[]>();
		if (postIds.length > 0) {
			const attachments = await db
				.select()
				.from(communityPostAttachments)
				.where(inArray(communityPostAttachments.postId, postIds));
			for (const a of attachments) {
				const list = attachmentMap.get(a.postId) ?? [];
				list.push({
					filename: a.filename,
					s3Key: a.s3Key,
					url: config.cdn.url + a.s3Key,
				});
				attachmentMap.set(a.postId, list);
			}
		}

		const data = rows.map((row) => {
			const post = this._formatPost(row, instructorSet, likedSet);
			post.attachments = attachmentMap.get(row.postId) ?? [];
			return post;
		});

		return {
			data,
			meta: {
				total: countRow?.total ?? 0,
				page,
				limit,
				totalPages: Math.ceil((countRow?.total ?? 0) / limit),
			},
		};
	};

	createPost = async (authData: IAuthData, slug: string, data: Record<string, any>) => {
		const community = await this._resolveCommunity(slug);
		const db = getDb();
		const userId = Number(authData.id);

		const [post] = await db
			.insert(communityPosts)
			.values({
				communityId: community.id,
				authorId: userId,
				content: data.content,
				isAnnouncement: data.isAnnouncement ?? false,
			} as any)
			.returning();

		/* Attachments */
		if (data.attachments?.length) {
			await db.insert(communityPostAttachments).values(
				data.attachments.map((a: any) => ({
					postId: post!.id,
					filename: a.filename,
					s3Key: a.s3Key,
				})),
			);
		}

		return this.getPostById(authData, post!.id);
	};

	getPostById = async (authData: IAuthData, postId: number) => {
		const db = getDb();
		const userId = Number(authData.id);

		const [row] = await db
			.select({
				postId: communityPosts.id,
				communityId: communityPosts.communityId,
				content: communityPosts.content,
				isPinned: communityPosts.isPinned,
				isAnnouncement: communityPosts.isAnnouncement,
				likeCount: communityPosts.likeCount,
				commentCount: communityPosts.commentCount,
				postCreatedAt: communityPosts.createdAt,
				postUpdatedAt: communityPosts.updatedAt,
				authorId: users.id,
				authorFirstName: users.firstName,
				authorLastName: users.lastName,
				authorAvatarUrl: users.avatarUrl,
			})
			.from(communityPosts)
			.innerJoin(users, eq(communityPosts.authorId, users.id))
			.where(and(
				eq(communityPosts.id, postId),
				isNull(communityPosts.deletedAt),
			))
			.limit(1);

		if (!row) throwNotFoundError("Post not found");

		const safeRow = row!;
		const instructorSet = await this._resolveInstructors([safeRow.authorId as number]);

		const [like] = await db
			.select({ id: communityPostLikes.id })
			.from(communityPostLikes)
			.where(
				and(
					eq(communityPostLikes.postId, postId),
					eq(communityPostLikes.userId, userId),
				),
			)
			.limit(1);

		const likedSet = new Set(like ? [postId] : []);

		const attachments = await db
			.select()
			.from(communityPostAttachments)
			.where(eq(communityPostAttachments.postId, postId));

		const post = this._formatPost(safeRow, instructorSet, likedSet);
		post.attachments = attachments.map((a) => ({
			filename: a.filename,
			s3Key: a.s3Key,
		}));
		return post;
	};

	updatePost = async (
		authData: IAuthData,
		postId: number,
		data: Record<string, any>,
	) => {
		const db = getDb();
		const userId = Number(authData.id);

		const [post] = await db
			.select()
			.from(communityPosts)
			.where(and(
				eq(communityPosts.id, postId),
				isNull(communityPosts.deletedAt),
			))
			.limit(1);

		if (!post) throwNotFoundError("Post not found");

		const safePost = post!;
		const isOwner = safePost.authorId === userId;

		/* Only owner can edit content/isAnnouncement */
		if ((data.content !== undefined || data.isAnnouncement !== undefined) && !isOwner) {
			throwBadRequestError("You can only edit your own posts");
		}

		/* Only owner/admin can toggle pin */
		if (data.isPinned !== undefined && !isOwner) {
			const [member] = await db
				.select({ memberRole: communityMembers.memberRole })
				.from(communityMembers)
				.where(
					and(
						eq(communityMembers.communityId, safePost.communityId),
						eq(communityMembers.userId, userId),
					),
				)
				.limit(1);
			if (!member || (member.memberRole !== "owner" && member.memberRole !== "admin")) {
				throwBadRequestError("Only admins can pin posts");
			}
		}

		const updates: Record<string, any> = {};
		if (data.content !== undefined) updates.content = data.content;
		if (data.isPinned !== undefined) updates.isPinned = data.isPinned;
		if (data.isAnnouncement !== undefined) updates.isAnnouncement = data.isAnnouncement;

		await db.update(communityPosts).set(updates).where(eq(communityPosts.id, postId));

		return this.getPostById(authData, postId);
	};

	deletePost = async (authData: IAuthData, postId: number) => {
		const db = getDb();
		const userId = Number(authData.id);

		const [post] = await db
			.select()
			.from(communityPosts)
			.where(and(
				eq(communityPosts.id, postId),
				isNull(communityPosts.deletedAt),
			))
			.limit(1);

		if (!post) throwNotFoundError("Post not found");

		const safePost = post!;
		if (safePost.authorId !== userId) {
			const [member] = await db
				.select({ memberRole: communityMembers.memberRole })
				.from(communityMembers)
				.where(
					and(
						eq(communityMembers.communityId, safePost.communityId),
						eq(communityMembers.userId, userId),
					),
				)
				.limit(1);
			if (!member || (member.memberRole !== "owner" && member.memberRole !== "admin")) {
				throwBadRequestError("You can only delete your own posts");
			}
		}

		await db
			.update(communityPosts)
			.set({ deletedAt: new Date() } as any)
			.where(eq(communityPosts.id, postId));
	};

	/* ── Likes ───────────────────────────────────────────────── */

	toggleLike = async (authData: IAuthData, postId: number) => {
		const db = getDb();
		const userId = Number(authData.id);

		const [post] = await db
			.select({ id: communityPosts.id, likeCount: communityPosts.likeCount, authorId: communityPosts.authorId })
			.from(communityPosts)
			.where(and(
				eq(communityPosts.id, postId),
				isNull(communityPosts.deletedAt),
			))
			.limit(1);

		if (!post) throwNotFoundError("Post not found");

		const safePost = post!;
		const currentLikeCount = safePost.likeCount ?? 0;

		const [existing] = await db
			.select({ id: communityPostLikes.id })
			.from(communityPostLikes)
			.where(
				and(
					eq(communityPostLikes.postId, postId),
					eq(communityPostLikes.userId, userId),
				),
			)
			.limit(1);

		if (existing) {
			/* Unlike */
			await db.delete(communityPostLikes).where(eq(communityPostLikes.id, existing.id));
			const newCount = Math.max(0, currentLikeCount - 1);
			await db
				.update(communityPosts)
				.set({ likeCount: newCount })
				.where(eq(communityPosts.id, postId));
			return { liked: false, likeCount: newCount };
		}

		/* Like */
		await db.insert(communityPostLikes).values({ postId, userId } as any);
		const newCount = currentLikeCount + 1;
		await db
			.update(communityPosts)
			.set({ likeCount: newCount })
			.where(eq(communityPosts.id, postId));

		/* @info - Notify the post author (not yourself) */
		if (Number(safePost.authorId) !== userId) {
			const notifier = NotificationService.getInstance();
			notifier.notify(
				Number(safePost.authorId),
				NotificationType.COMMUNITY,
				"New like on your post",
				`Someone liked your community post`,
				{ postId },
			);
		}
		return { liked: true, likeCount: newCount };
	};

	/* ── Comments ────────────────────────────────────────────── */

	listComments = async (
		authData: IAuthData,
		postId: number,
	) => {
		const db = getDb();

		const [post] = await db
			.select({ id: communityPosts.id })
			.from(communityPosts)
			.where(eq(communityPosts.id, postId))
			.limit(1);

		if (!post) throwNotFoundError("Post not found");

		const rows = await db
			.select({
				commentId: communityPostComments.id,
				postId: communityPostComments.postId,
				parentId: communityPostComments.parentId,
				content: communityPostComments.content,
				isInstructorReply: communityPostComments.isInstructorReply,
				createdAt: communityPostComments.createdAt,
				updatedAt: communityPostComments.updatedAt,
				authorId: users.id,
				authorFirstName: users.firstName,
				authorLastName: users.lastName,
				authorAvatarUrl: users.avatarUrl,
			})
			.from(communityPostComments)
			.innerJoin(users, eq(communityPostComments.authorId, users.id))
			.where(and(
				eq(communityPostComments.postId, postId),
				isNull(communityPostComments.deletedAt),
			))
			.orderBy(communityPostComments.createdAt);

		const authorIds = [...new Set(rows.map((r) => r.authorId as number))];
		const instructorSet = await this._resolveInstructors(authorIds);

		return rows.map((row) => {
			const author = this._buildAuthor(row, instructorSet);
			return withPresignedUrl(
				{
					id: row.commentId,
					postId: row.postId,
					parentId: row.parentId as number | null,
					author,
					content: row.content,
					isInstructorReply: row.isInstructorReply,
					createdAt: row.createdAt,
					editedAt:
						(row.updatedAt as unknown as string) !== (row.createdAt as unknown as string)
							? (row.updatedAt as unknown as string)
							: null,
				},
				"avatarUrl",
			);
		});
	};

	createComment = async (
		authData: IAuthData,
		postId: number,
		data: { content: string; parentId?: number },
	) => {
		const db = getDb();
		const userId = Number(authData.id);

		const [post] = await db
			.select({ id: communityPosts.id, authorId: communityPosts.authorId })
			.from(communityPosts)
			.where(and(
				eq(communityPosts.id, postId),
				isNull(communityPosts.deletedAt),
			))
			.limit(1);

		if (!post) throwNotFoundError("Post not found");

		/* Validate parentId if provided */
		if (data.parentId) {
			const [parent] = await db
				.select({ id: communityPostComments.id })
				.from(communityPostComments)
				.where(and(
					eq(communityPostComments.id, data.parentId),
					isNull(communityPostComments.deletedAt),
				))
				.limit(1);
			if (!parent) throwNotFoundError("Parent comment not found");
		}

		/* Check if author is an instructor */
		const [roleRow] = await db
			.select({ role: user_roles.role })
			.from(user_roles)
			.where(
				and(
					eq(user_roles.userId, userId),
					eq(user_roles.role, "instructor"),
				),
			)
			.limit(1);

		const [comment] = await db
			.insert(communityPostComments)
			.values({
				postId,
				authorId: userId,
				parentId: data.parentId ?? null,
				content: data.content,
				isInstructorReply: !!roleRow,
			} as any)
			.returning();

		/* Increment post commentCount */
		await db
			.update(communityPosts)
			.set({ commentCount: sql`${communityPosts.commentCount} + 1` })
			.where(eq(communityPosts.id, postId));

		/* @info - Notify the post author (not yourself) */
		if (Number(post!.authorId) !== userId) {
			const notifier = NotificationService.getInstance();
			notifier.notify(
				Number(post!.authorId),
				NotificationType.COMMUNITY,
				"New comment on your post",
				`${data.content.slice(0, 80)}${data.content.length > 80 ? "…" : ""}`,
				{ postId, commentId: (comment as any).id },
			);
		}

		/* Fetch author info */
		const [user] = await db
			.select({
				id: users.id,
				firstName: users.firstName,
				lastName: users.lastName,
				avatarUrl: users.avatarUrl,
			})
			.from(users)
			.where(eq(users.id, userId))
			.limit(1);

		const author: AuthorInfo = {
			id: userId,
			firstName: user!.firstName,
			lastName: user!.lastName,
			avatarUrl: user!.avatarUrl,
			isInstructor: !!roleRow,
		};

		return withPresignedUrl(
			{
				id: comment!.id,
				postId: comment!.postId,
				parentId: comment!.parentId as number | null,
				author,
				content: comment!.content,
				isInstructorReply: comment!.isInstructorReply,
				createdAt: comment!.createdAt,
				editedAt: null,
			},
			"avatarUrl",
		);
	};

	updateComment = async (
		authData: IAuthData,
		commentId: number,
		data: { content: string },
	) => {
		const db = getDb();
		const userId = Number(authData.id);

		const [comment] = await db
			.select()
			.from(communityPostComments)
			.where(and(
				eq(communityPostComments.id, commentId),
				isNull(communityPostComments.deletedAt),
			))
			.limit(1);

		if (!comment) throwNotFoundError("Comment not found");

		const safeComment = comment!;

		if (safeComment.authorId !== userId) {
			throwBadRequestError("You can only edit your own comments");
		}

		const [updated] = await db
			.update(communityPostComments)
			.set({ content: data.content })
			.where(eq(communityPostComments.id, commentId))
			.returning();

		return { id: updated!.id, content: updated!.content, updatedAt: updated!.updatedAt };
	};

	deleteComment = async (authData: IAuthData, commentId: number) => {
		const db = getDb();
		const userId = Number(authData.id);

		const [comment] = await db
			.select()
			.from(communityPostComments)
			.where(and(
				eq(communityPostComments.id, commentId),
				isNull(communityPostComments.deletedAt),
			))
			.limit(1);

		if (!comment) throwNotFoundError("Comment not found");

		const safeComment = comment!;

		if (safeComment.authorId !== userId) {
			/* Check if admin */
			const [post] = await db
				.select({ communityId: communityPosts.communityId })
				.from(communityPosts)
				.where(eq(communityPosts.id, safeComment.postId))
				.limit(1);

			if (post) {
				const [member] = await db
					.select({ memberRole: communityMembers.memberRole })
					.from(communityMembers)
					.where(
						and(
							eq(communityMembers.communityId, post.communityId),
							eq(communityMembers.userId, userId),
						),
					)
					.limit(1);
				if (!member || (member.memberRole !== "owner" && member.memberRole !== "admin")) {
					throwBadRequestError("You can only delete your own comments");
				}
			} else {
				throwBadRequestError("You can only delete your own comments");
			}
		}

		await db
			.update(communityPostComments)
			.set({ deletedAt: new Date() } as any)
			.where(eq(communityPostComments.id, commentId));

		/* Decrement post commentCount */
		await db
			.update(communityPosts)
			.set({ commentCount: sql`greatest(0, ${communityPosts.commentCount} - 1)` })
			.where(eq(communityPosts.id, safeComment.postId));
	};
}
