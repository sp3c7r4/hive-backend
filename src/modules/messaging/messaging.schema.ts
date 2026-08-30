import { z } from "zod";
import { MessageType } from "@/enums";

export const createConversationSchema = z.object({
	participantId: z.number().int().positive(),
});

export const sendMessageSchema = z.object({
	recipientId: z.number().int().positive().optional(),
	communityId: z.number().int().positive().optional(),
	content: z.string().trim().min(1).max(2000).optional(),
	attachmentType: z.nativeEnum(MessageType).optional(),
	attachmentUrl: z.string().max(1000).optional(),
}).refine((v) => v.recipientId || v.communityId, {
	message: "Either recipientId or communityId is required",
});

export const messagesQuerySchema = z.object({
	before: z.coerce.number().int().positive().optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
});
