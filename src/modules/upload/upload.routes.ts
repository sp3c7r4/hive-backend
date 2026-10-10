import { Hono } from "hono";
import { z } from "zod";
import { JwtService, ZodEngine } from "@/services";
import { UploadController } from "./upload.controller";

export const uploadRouter = new Hono({ strict: true });

const controller = UploadController.getInstance();
const zod = ZodEngine.getInstance();
const jwt = JwtService.getInstance();

const presignedUploadSchema = z.object({
	contentType: z.string().min(1, "contentType is required"),
	filename: z.string().min(1, "filename is required"),
	/* @info - An allowlisted purpose, not a path. Deliberately a loose string
	 * here: the controller holds the allowlist (PRESIGN_FOLDERS) and answers a
	 * message a person can read, rather than Zod's option list. */
	folder: z.string().optional(),
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

/** Direct upload for lesson videos (MP4/MOV/WebM) */
uploadRouter.post("/video", controller.uploadVideo);

uploadRouter.get("/files/:key/download", controller.presignedDownload);
