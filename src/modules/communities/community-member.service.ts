import { eq, and, isNull, ilike, or, count } from "drizzle-orm";
import { throwNotFoundError, throwBadRequestError, throwForbiddenError } from "@/helpers/errors/throw-errors";
import { withPresignedUrl } from "@/helpers/storage.helper";
import { config } from "@/config";
import { getDb } from "@/db/postgres.db";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { EmailJobNames } from "@/enums";
import { EmailQueueService } from "@/services/queues/email.queue.service";
import { CommunityRepository } from "./community.repository";
import { MessagingRepository } from "@/modules/messaging/messaging.repository";
import { communities, communityMembers, communityInvites } from "./community.model";
import { users } from "@/modules/user/user.model";
import { user_roles } from "@/modules/user/user-role.model";

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

		await db.delete(communityMembers).where(eq(communityMembers.id, member!.id));
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

		this.notifyCommunityChat(community.id, community.name, targetUserId).catch(() => {});

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

		await db.delete(communityMembers).where(eq(communityMembers.id, member!.id));
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

		if (existingInvite) throwBadRequestError("Invite already sent to this email");

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

	joinCommunity = async (authData: IAuthData, slug: string) => {
		const community = await this._resolveCommunity(slug);
		const db = getDb();
		const userId = Number(authData.id);

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

		if (existingMember) throwBadRequestError("Already a member of this community");

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
			pendingInvite || !(community as any).requiresApproval ? "active" : "pending";

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
			this.notifyCommunityChat(community.id, community.name, userId).catch(() => {});
		}

		return member;
	};

	/** @info - Fire-and-forget: ensure the group chat and insert a join system message. */
	private notifyCommunityChat = async (communityId: number, name: string, userId: number) => {
		const repo = MessagingRepository.getInstance();
		const conversation = await repo.ensureCommunityConversation(communityId, name);
		if (!conversation) return;
		await repo.insertSystemMessage(conversation.id, userId, "joined the community");
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
			throwBadRequestError("Community owner cannot leave. Transfer ownership first.");
		}

		await db.delete(communityMembers).where(eq(communityMembers.id, member!.id));
	};
}
