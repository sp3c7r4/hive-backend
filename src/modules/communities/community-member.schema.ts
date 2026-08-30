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
