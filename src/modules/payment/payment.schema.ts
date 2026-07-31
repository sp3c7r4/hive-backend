import z from "zod";

export const cancelPaymentSchema = z.object({
	trackingCode: z.string(),
});
