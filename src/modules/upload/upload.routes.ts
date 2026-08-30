import { Hono } from "hono";
import { JwtService, ZodEngine } from "@/services";
import { UploadController } from "./upload.controller";

import { z } from "zod";

export const uploadRouter = new Hono({ strict: true });

const controller = UploadController.getInstance();
const zod = ZodEngine.getInstance();
const jwt = JwtService.getInstance();


const presignedUploadSchema = z.object({
	contentType: z.string().min(1, "contentType is required"),
	filename: z.string().min(1, "filename is required"),
});

uploadRouter.use("*", jwt.validateToken);

uploadRouter.post(
	"/presigned",
	zod.validate.body(presignedUploadSchema),
	controller.presignedUpload,
);

/** Direct upload for feed images — server handles S3, no CORS issues */
uploadRouter.post("/feed-image", controller.uploadFeedImage);

/** Direct upload for chat/message attachments (PDF, DOC/DOCX, images) */
uploadRouter.post("/attachment", controller.uploadAttachment);

uploadRouter.get("/files/:key/download", controller.presignedDownload);
