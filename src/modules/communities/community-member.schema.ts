import { z } from "zod";
import { CommunityMemberRole, CommunityMemberStatus } from "@/enums";

export const updateMemberSchema = z.object({
	memberRole: z.nativeEnum(CommunityMemberRole).optional(),
	status: z.nativeEnum(CommunityMemberStatus).optional(),
}).refine(data => data.memberRole !== undefined || data.status !== undefined, {
	message: "At least one of memberRole or status must be provided",
});

export const inviteMemberSchema = z.object({
	email: z.string().email().max(255),
});

export const bulkInviteSchema = z.object({
	emails: z
		.array(z.string().max(255))
		.min(1, "Add at least one email address")
		.max(200, "Send at most 200 invitations at a time"),
});
