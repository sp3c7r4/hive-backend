import { and, count, desc, eq, ilike, isNull, ne, or } from "drizzle-orm";
import { config } from "@/config";
import { getDb } from "@/db/postgres.db";
import { EmailJobNames } from "@/enums";
import {
	throwBadRequestError,
	throwForbiddenError,
	throwNotFoundError,
} from "@/helpers/errors/throw-errors";
import { withPresignedUrl } from "@/helpers/storage.helper";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { MessagingRepository } from "@/modules/messaging/messaging.repository";
import { payments } from "@/modules/payment/payment.model";
import { users } from "@/modules/user/user.model";
import { user_roles } from "@/modules/user/user-role.model";
import { EmailQueueService } from "@/services/queues/email.queue.service";
import {
	communities,
	communityInvites,
	communityMembers,
} from "./community.model";
import { CommunityRepository } from "./community.repository";

export class CommunityMemberService {
	private static instance: CommunityMemberService;
	private readonly communityRepo = CommunityRepository.getInstance();
	private readonly emailQueue = EmailQueueService.getInstance();

	static getInstance(): CommunityMemberService {
		if (!this.instance) this.instance = new CommunityMemberService();
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

	private async _getMemberCount(communityId: number): Promise<number> {
		const db = getDb();
		const [row] = await db
			.select({ value: count() })
			.from(communityMembers)
			.where(
				and(
					eq(communityMembers.communityId, communityId),
					eq(communityMembers.status, "active"),
				),
			);
		return Number(row?.value ?? 0);
	}

	/* ── Members ─────────────────────────────────────────────── */

	listMembers = async (
		authData: IAuthData,
		slug: string,
		params?: { search?: string; status?: string },
	) => {
		const community = await this._resolveCommunity(slug);
		const db = getDb();

		const conditions: any[] = [
			eq(communityMembers.communityId, community.id),
			isNull(users.deletedAt),
			/* The owner manages the community — not shown as a member */
			ne(communityMembers.memberRole, "owner"),
		];

		if (params?.status) {
			conditions.push(eq(communityMembers.status, params.status));
		}

		if (params?.search) {
			const term = `%${params.search}%`;
			conditions.push(
				or(
					ilike(users.firstName, term),
					ilike(users.lastName, term),
					ilike(users.email, term),
				) as any,
			);
		}

		const rows = await db
			.select({
				id: communityMembers.id,
				userId: communityMembers.userId,
				communityId: communityMembers.communityId,
				role: communityMembers.role,
				memberRole: communityMembers.memberRole,
				status: communityMembers.status,
				joinedAt: communityMembers.joinedAt,
				created_at: communityMembers.createdAt,
				updated_at: communityMembers.updatedAt,
				firstName: users.firstName,
				lastName: users.lastName,
				email: users.email,
				avatarUrl: users.avatarUrl,
			})
			.from(communityMembers)
			.innerJoin(users, eq(communityMembers.userId, users.id))
			.where(and(...conditions));

		return rows.map((row) => withPresignedUrl(row, "avatarUrl"));
	};

	/**
	 * @info - Aggregate members across ALL communities the instructor owns.
	 *         Used by the instructor dashboard Members section. Joined with
	 *         communities + users; paginated; `counts` reflect the owned set.
	 */
	listMine = async (
		authData: IAuthData,
		params?: {
			search?: string;
			status?: string;
			communityId?: number;
			page?: number;
			limit?: number;
		},
	) => {
		const db = getDb();
		const page = Math.max(1, Number(params?.page) || 1);
		const limit = Math.max(1, Math.min(Number(params?.limit) || 30, 100));
		const offset = (page - 1) * limit;

		const conditions: any[] = [
			eq(communities.ownerId, Number(authData.id)),
			isNull(communities.deletedAt),
			isNull(users.deletedAt),
			/* The owner manages the community — not shown as a member */
			ne(communityMembers.memberRole, "owner"),
		];
		if (params?.status)
			conditions.push(eq(communityMembers.status, params.status as any));
		if (params?.communityId)
			conditions.push(
				eq(communityMembers.communityId, Number(params.communityId)),
			);
		if (params?.search) {
			const term = `%${params.search}%`;
			conditions.push(
				or(
					ilike(users.firstName, term),
					ilike(users.lastName, term),
					ilike(users.email, term),
				) as any,
			);
		}

		const selectShape = {
			id: communityMembers.id,
			userId: communityMembers.userId,
			communityId: communityMembers.communityId,
			communityName: communities.name,
			communitySlug: communities.slug,
			memberRole: communityMembers.memberRole,
			status: communityMembers.status,
			joinedAt: communityMembers.joinedAt,
			firstName: users.firstName,
			lastName: users.lastName,
			email: users.email,
			avatarUrl: users.avatarUrl,
		};

		const [rows, [{ value: total }], countsRows] = await Promise.all([
			db
				.select(selectShape)
				.from(communityMembers)
				.innerJoin(
					communities,
					eq(communityMembers.communityId, communities.id),
				)
				.innerJoin(users, eq(communityMembers.userId, users.id))
				.where(and(...conditions))
				.orderBy(desc(communityMembers.joinedAt), desc(communityMembers.id))
				.limit(limit)
				.offset(offset) as any,
			db
				.select({ value: count() })
				.from(communityMembers)
				.innerJoin(
					communities,
					eq(communityMembers.communityId, communities.id),
				)
				.innerJoin(users, eq(communityMembers.userId, users.id))
				.where(and(...conditions)) as any,
			db
				.select({ status: communityMembers.status, value: count() })
				.from(communityMembers)
				.innerJoin(
					communities,
					eq(communityMembers.communityId, communities.id),
				)
				.innerJoin(users, eq(communityMembers.userId, users.id))
				.where(
					and(
						eq(communities.ownerId, Number(authData.id)),
						isNull(communities.deletedAt),
						isNull(users.deletedAt),
						ne(communityMembers.memberRole, "owner"),
					),
				)
				.groupBy(communityMembers.status) as any,
		]);

		const items = (rows as any[]).map((row) =>
			withPresignedUrl(row, "avatarUrl"),
		);
		const counts = { active: 0, pending: 0, blocked: 0 };
		for (const row of countsRows as any[]) {
			counts[row.status as keyof typeof counts] = Number(row.value);
		}

		const totalPages = Math.ceil(Number(total) / limit);
		return {
			items,
			meta: { total: Number(total), page, limit, totalPages },
			counts,
		};
	};

	updateMember = async (
		authData: IAuthData,
		slug: string,
		targetUserId: number,
		data: { memberRole?: string; status?: string },
	) => {
		const community = await this._resolveCommunity(slug);
		const db = getDb();

		const [member] = await db
			.select()
			.from(communityMembers)
			.where(
				and(
					eq(communityMembers.communityId, community.id),
					eq(communityMembers.userId, targetUserId),
				),
			)
			.limit(1);

		if (!member) throwNotFoundError("Member not found");

		/* Owner guard — the owner cannot be blocked, demoted or status-changed */
		if (member!.memberRole === "owner")
			throwForbiddenError("The owner cannot be modified");

		const updates: Record<string, any> = {};
		if (data.memberRole !== undefined) updates.memberRole = data.memberRole;
		if (data.status !== undefined) updates.status = data.status;

		const [updated] = await db
			.update(communityMembers)
			.set(updates)
			.where(eq(communityMembers.id, member!.id))
			.returning();

		return updated;
	};

	removeMember = async (
		authData: IAuthData,
		slug: string,
		targetUserId: number,
	) => {
		const community = await this._resolveCommunity(slug);
		const db = getDb();

		const [member] = await db
			.select()
			.from(communityMembers)
			.where(
				and(
					eq(communityMembers.communityId, community.id),
					eq(communityMembers.userId, targetUserId),
				),
			)
			.limit(1);

		if (!member) throwNotFoundError("Member not found");

		/* Owner guard — the owner cannot be removed */
		if (member!.memberRole === "owner")
			throwForbiddenError("The owner cannot be removed");

		await db
			.delete(communityMembers)
			.where(eq(communityMembers.id, member!.id));
	};

	approveMember = async (
		authData: IAuthData,
		slug: string,
		targetUserId: number,
	) => {
		const community = await this._resolveCommunity(slug);
		const db = getDb();

		const [member] = await db
			.select()
			.from(communityMembers)
			.where(
				and(
					eq(communityMembers.communityId, community.id),
					eq(communityMembers.userId, targetUserId),
					eq(communityMembers.status, "pending"),
				),
			)
			.limit(1);

		if (!member) throwNotFoundError("Pending member not found");

		const [updated] = await db
			.update(communityMembers)
			.set({ status: "active" })
			.where(eq(communityMembers.id, member!.id))
			.returning();

		this.notifyCommunityChat(community.id, community.name, targetUserId).catch(
			() => {},
		);

		/* @info - Tell the approved student their request went through */
		const [approvedUser] = await db
			.select({ email: users.email, firstName: users.firstName })
			.from(users)
			.where(eq(users.id, targetUserId))
			.limit(1);
		if (approvedUser?.email) {
			this.emailQueue.add(EmailJobNames.MEMBERSHIP_APPROVED as any, {
				message: {
					to: approvedUser.email,
					subject: `Your request to join ${(community as any).name} was approved`,
				},
				template: "membership-approved" as any,
				locals: {
					memberName: approvedUser.firstName ?? "",
					communityName: (community as any).name,
					communityLink: `${
						process.env.APP_URL ||
						`https://${config.server.serverDomain}`
					}/dashboard/explore/communities/${(community as any).slug}`,
				},
			});
		}

		return updated;
	};

	rejectMember = async (
		authData: IAuthData,
		slug: string,
		targetUserId: number,
	) => {
		const community = await this._resolveCommunity(slug);
		const db = getDb();

		const [member] = await db
			.select()
			.from(communityMembers)
			.where(
				and(
					eq(communityMembers.communityId, community.id),
					eq(communityMembers.userId, targetUserId),
					eq(communityMembers.status, "pending"),
				),
			)
			.limit(1);

		if (!member) throwNotFoundError("Pending member not found");

		await db
			.delete(communityMembers)
			.where(eq(communityMembers.id, member!.id));
	};

	/* ── Invites ─────────────────────────────────────────────── */

	listInvites = async (authData: IAuthData, slug: string) => {
		const community = await this._resolveCommunity(slug);
		const db = getDb();

		return db
			.select()
			.from(communityInvites)
			.where(eq(communityInvites.communityId, community.id));
	};

	createInvite = async (
		authData: IAuthData,
		slug: string,
		data: { email: string },
	) => {
		const community = await this._resolveCommunity(slug);
		const db = getDb();

		/* Check if user with this email is already a member */
		const [existingUser] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, data.email))
			.limit(1);

		if (existingUser) {
			const [existingMember] = await db
				.select({ id: communityMembers.id })
				.from(communityMembers)
				.where(
					and(
						eq(communityMembers.communityId, community.id),
						eq(communityMembers.userId, existingUser.id),
					),
				)
				.limit(1);

			if (existingMember) throwBadRequestError("User is already a member");
		}

		/* Check if a pending invite already exists */
		const [existingInvite] = await db
			.select({ id: communityInvites.id })
			.from(communityInvites)
			.where(
				and(
					eq(communityInvites.communityId, community.id),
					eq(communityInvites.email, data.email),
					eq(communityInvites.status, "pending"),
				),
			)
			.limit(1);

		if (existingInvite)
			throwBadRequestError("Invite already sent to this email");

		const [invite] = await db
			.insert(communityInvites)
			.values({
				communityId: community.id,
				invitedBy: Number(authData.id),
				email: data.email,
				status: "pending",
			} as any)
			.returning();

		this.emailQueue.add(EmailJobNames.COMMUNITY_INVITE as any, {
			message: {
				to: data.email,
				subject: `You've been invited to join ${(community as any).name}`,
			},
			template: "community-invite" as any,
			locals: {
				inviteeName: "",
				communityName: (community as any).name,
				inviterName: authData.firstName ?? "Someone",
				inviteLink: `${process.env.APP_URL || `https://${config.server.serverDomain}`}/join?community=${(community as any).slug}`,
			},
		});

		return invite;
	};

	cancelInvite = async (
		authData: IAuthData,
		slug: string,
		inviteId: number,
	) => {
		const community = await this._resolveCommunity(slug);
		const db = getDb();

		const [invite] = await db
			.select()
			.from(communityInvites)
			.where(
				and(
					eq(communityInvites.id, inviteId),
					eq(communityInvites.communityId, community.id),
				),
			)
			.limit(1);

		if (!invite) throwNotFoundError("Invite not found");

		await db.delete(communityInvites).where(eq(communityInvites.id, inviteId));
	};

	/* ── Join / Leave ────────────────────────────────────────── */

	joinCommunity = async (authData: IAuthData, slug: string, paymentReference?: string) => {
		const community = await this._resolveCommunity(slug);
		const db = getDb();
		const userId = Number(authData.id);

		/* @info - Paid-community gate: a success payment for THIS community is required */
		if ((community as any).price && (community as any).price > 0) {
			if (!paymentReference) throwBadRequestError("Payment required to join this community");
			const [paid] = await db
				.select()
				.from(payments)
				.where(
					and(
						eq(payments.reference, paymentReference!),
						eq(payments.communityId, community!.id),
						eq(payments.payerId, userId),
						eq(payments.status, "success" as any),
					)!,
				)
				.limit(1);
			if (!paid) throwBadRequestError("Valid payment required to join this community");
		}
		/* Already a member? */
		const [existingMember] = await db
			.select()
			.from(communityMembers)
			.where(
				and(
					eq(communityMembers.communityId, community.id),
					eq(communityMembers.userId, userId),
				),
			)
			.limit(1);

		if (existingMember)
			throwBadRequestError("Already a member of this community");

		/* Accept pending invite if one exists */
		const [pendingInvite] = await db
			.select()
			.from(communityInvites)
			.where(
				and(
					eq(communityInvites.communityId, community.id),
					eq(communityInvites.email, authData.email!),
					eq(communityInvites.status, "pending"),
				),
			)
			.limit(1);

		if (pendingInvite) {
			await db
				.update(communityInvites)
				.set({ status: "accepted", acceptedAt: new Date() } as any)
				.where(eq(communityInvites.id, pendingInvite.id));
		}

		/* Visibility enforcement: invite-only requires a pending invite */
		const visibility = (community as any).visibility as string;
		if (visibility === "invite_only" && !pendingInvite) {
			throwForbiddenError(
				"This community is invite-only. Ask the owner for an invitation.",
			);
		}

		/* Look up user role */
		const [roleRow] = await db
			.select({ role: user_roles.role })
			.from(user_roles)
			.where(eq(user_roles.userId, userId))
			.limit(1);

		const userRole = roleRow?.role ?? "student";

		/* Communities are learning spaces — only students join via link/button */
		if (userRole !== "student") {
			throwForbiddenError("Only students can join communities");
		}

		/* Invited users skip approval (the invite IS the approval) */
		const status =
			pendingInvite || !(community as any).requiresApproval
				? "active"
				: "pending";

		const [member] = await db
			.insert(communityMembers)
			.values({
				communityId: community.id,
				userId,
				role: userRole,
				memberRole: "member",
				status,
			} as any)
			.returning();

		/* Auto-provision the community chat + a "joined" system message (best-effort) */
		if (status === "active") {
			this.notifyCommunityChat(community.id, community.name, userId).catch(
				() => {},
			);
		}

		return member;
	};

	/** @info - Fire-and-forget: ensure the group chat and insert a join system message. */
	private notifyCommunityChat = async (
		communityId: number,
		name: string,
		userId: number,
	) => {
		const repo = MessagingRepository.getInstance();
		const conversation = await repo.ensureCommunityConversation(
			communityId,
			name,
		);
		if (!conversation) return;
		await repo.insertSystemMessage(
			conversation.id,
			userId,
			"joined the community",
		);
	};

	leaveCommunity = async (authData: IAuthData, slug: string) => {
		const community = await this._resolveCommunity(slug);
		const db = getDb();
		const userId = Number(authData.id);

		const [member] = await db
			.select()
			.from(communityMembers)
			.where(
				and(
					eq(communityMembers.communityId, community.id),
					eq(communityMembers.userId, userId),
				),
			)
			.limit(1);

		if (!member) throwNotFoundError("You are not a member of this community");

		if (member!.memberRole === "owner") {
			throwBadRequestError(
				"Community owner cannot leave. Transfer ownership first.",
			);
		}

		await db
			.delete(communityMembers)
			.where(eq(communityMembers.id, member!.id));
	};
}
