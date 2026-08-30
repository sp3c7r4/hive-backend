import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendSuccessResponse } from "@/helpers";
import { CommunityMemberService } from "./community-member.service";

export class CommunityMemberController {
	private static instance: CommunityMemberController;
	private service: CommunityMemberService;

	static getInstance(): CommunityMemberController {
		if (!this.instance) this.instance = new CommunityMemberController();
		return this.instance;
	}

	private constructor() {
		this.service = CommunityMemberService.getInstance();
	}

	/* ── Members ─────────────────────────────────────────────── */

	listMembers = async (c: Context) => {
		const authData = c.get("authData");
		const slug = c.req.param("slug") as string;
		const search = c.req.query("search");
		const status = c.req.query("status");

		const data = await this.service.listMembers(authData, slug, {
			search,
			status,
		});
		return sendSuccessResponse(c, {
			message: "Members fetched successfully",
			data,
		});
	};

	/** @info - Instructor dashboard aggregate: members across owned communities */
	listMine = async (c: Context) => {
		const authData = c.get("authData");
		const search = c.req.query("search");
		const status = c.req.query("status");
		const communityId = c.req.query("communityId")
			? Number(c.req.query("communityId"))
			: undefined;
		const page = c.req.query("page") ? Number(c.req.query("page")) : undefined;
		const limit = c.req.query("limit")
			? Number(c.req.query("limit"))
			: undefined;

		const data = await this.service.listMine(authData, {
			search,
			status,
			communityId,
			page,
			limit,
		});
		return sendSuccessResponse(c, {
			message: "Members fetched successfully",
			data,
		});
	};

	updateMember = async (c: Context) => {
		const authData = c.get("authData");
		const slug = c.req.param("slug") as string;
		const targetUserId = Number(c.req.param("userId"));
		const body = await c.req.json();

		const data = await this.service.updateMember(
			authData,
			slug,
			targetUserId,
			body,
		);
		return sendSuccessResponse(c, {
			message: "Member updated successfully",
			data,
		});
	};

	removeMember = async (c: Context) => {
		const authData = c.get("authData");
		const slug = c.req.param("slug") as string;
		const targetUserId = Number(c.req.param("userId"));

		await this.service.removeMember(authData, slug, targetUserId);
		return sendSuccessResponse(c, {
			message: "Member removed successfully",
		});
	};

	approveMember = async (c: Context) => {
		const authData = c.get("authData");
		const slug = c.req.param("slug") as string;
		const targetUserId = Number(c.req.param("userId"));

		const data = await this.service.approveMember(authData, slug, targetUserId);
		return sendSuccessResponse(c, {
			message: "Member approved successfully",
			data,
		});
	};

	rejectMember = async (c: Context) => {
		const authData = c.get("authData");
		const slug = c.req.param("slug") as string;
		const targetUserId = Number(c.req.param("userId"));

		await this.service.rejectMember(authData, slug, targetUserId);
		return sendSuccessResponse(c, {
			message: "Member rejected successfully",
		});
	};

	/* ── Invites ─────────────────────────────────────────────── */

	listInvites = async (c: Context) => {
		const authData = c.get("authData");
		const slug = c.req.param("slug") as string;

		const data = await this.service.listInvites(authData, slug);
		return sendSuccessResponse(c, {
			message: "Invites fetched successfully",
			data,
		});
	};

	createInvite = async (c: Context) => {
		const authData = c.get("authData");
		const slug = c.req.param("slug") as string;
		const body = await c.req.json();

		const data = await this.service.createInvite(authData, slug, body);
		return sendSuccessResponse(
			c,
			{
				message: "Invite sent successfully",
				data,
			},
			StatusCodes.CREATED,
		);
	};

	cancelInvite = async (c: Context) => {
		const authData = c.get("authData");
		const slug = c.req.param("slug") as string;
		const inviteId = Number(c.req.param("inviteId"));

		await this.service.cancelInvite(authData, slug, inviteId);
		return sendSuccessResponse(c, {
			message: "Invite cancelled successfully",
		});
	};

	/* ── Join / Leave ────────────────────────────────────────── */

	joinCommunity = async (c: Context) => {
		const authData = c.get("authData");
		const slug = c.req.param("slug") as string;
		const body = await c.req.json().catch(() => ({}));

		const data = await this.service.joinCommunity(authData, slug, body.paymentReference);
		return sendSuccessResponse(
			c,
			{
				message:
					(data as any).status === "pending"
						? "Join request submitted for approval"
						: "Joined community successfully",
				data,
			},
			StatusCodes.CREATED,
		);
	};

	leaveCommunity = async (c: Context) => {
		const authData = c.get("authData");
		const slug = c.req.param("slug") as string;

		await this.service.leaveCommunity(authData, slug);
		return sendSuccessResponse(c, {
			message: "Left community successfully",
		});
	};
}
