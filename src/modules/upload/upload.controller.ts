import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { config } from "@/config";
import { sendErrorResponse, sendSuccessResponse } from "@/helpers/response/send-response";
import { StorageService } from "@/services/storage.service";
import { nanoid } from "nanoid";
import { generateImageKey } from "@/helpers/id-generators";

const MIME_BY_EXT: Record<string, string> = {
	mp4: "video/mp4",
	mov: "video/quicktime",
	webm: "video/webm",
	m4v: "video/x-m4v",
	mpeg: "video/mpeg",
	pdf: "application/pdf",
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
};

/** @info - Browsers sometimes send an empty or octet-stream type for real
 * files; infer from the extension so valid uploads are never rejected. */
const inferMime = (file: File) => {
	if (
		file.type &&
		file.type !== "application/octet-stream" &&
		file.type !== "text/plain"
	)
		return file.type;
	const ext = (file.name.split(".").pop() ?? "").toLowerCase();
	return MIME_BY_EXT[ext] ?? file.type;
};

export class UploadController {
	private static instance: UploadController;

	private readonly storage: StorageService;

	static getInstance(): UploadController {
		if (!this.instance) this.instance = new UploadController();
		return this.instance;
	}

	private constructor() {
		this.storage = StorageService.getInstance();
	}

	presignedUpload = async (c: Context) => {
		const authData = c.get("authData");
		const { contentType, filename, folder } = await c.req.json();

		const ext = filename.split(".").pop() ?? "bin";
		const folderName = folder ?? "uploads";
		const key = generateImageKey(folderName, ext, authData.id.toString());

		const result = await this.storage.generatePresignedUploadUrl({
			key,
			contentType,
		});

		return sendSuccessResponse(
			c,
			{ ...result, s3Url: `${config.cdn.url}${key}` },
			StatusCodes.CREATED,
		);
	};

	presignedDownload = async (c: Context) => {
		const key = c.req.param("key") as string;

		const url = await this.storage.generatePresignedDownloadUrl({ key });

		return sendSuccessResponse(c, { url });
	};

	/** Server-side upload for feed images — returns public S3 URL directly */
	uploadAttachment = async (c: Context) => {
		const formData = await c.req.formData();
		const file = formData.get("file") as File | null;

		const allowed = [
			"application/pdf",
			"application/msword",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			"image/jpeg",
			"image/png",
			"image/gif",
			"image/webp",
		];
		if (!file || !(file instanceof File)) {
			return sendErrorResponse(
				c,
				{ message: "Missing or invalid file for field 'file'" },
				StatusCodes.BAD_REQUEST,
			);
		}
		if (file.size > 10 * 1024 * 1024) {
			return sendErrorResponse(
				c,
				{ message: "File exceeds size limit of 10 MB" },
				StatusCodes.BAD_REQUEST,
			);
		}
		const fileType = inferMime(file);
		if (!allowed.includes(fileType)) {
			return sendErrorResponse(
				c,
				{ message: `Invalid file type '${fileType}'. Allowed: PDF, DOC, DOCX, JPEG, PNG, GIF, WebP` },
				StatusCodes.BAD_REQUEST,
			);
		}

		/* Preserve the original filename in the S3 key so chat bubbles and
		 * file chips can display a human-friendly name after reloads. */
		const ext = file.name.split(".").pop() ?? file.type.split("/")[1] ?? "bin";
		const safeName =
			file.name
				.replace(/\.[^.]+$/, "")
				.replace(/[^a-zA-Z0-9._-]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 60) || "attachment";
		const key = `images/files/general/${Date.now()}-${nanoid(6)}-${safeName}.${ext}`;

		await this.storage.upload({
			key,
			body: file,
			contentType: fileType,
		});

		const publicUrl = `${config.cdn.url}${key}`;
		return sendSuccessResponse(
			c,
			{ url: publicUrl, key, name: file.name },
			StatusCodes.CREATED,
		);
	};

	uploadFeedImage = async (c: Context) => {
		const authData = c.get("authData");
		const formData = await c.req.formData();
		const file = formData.get("file") as File | null;

		if (!file || !(file instanceof File)) {
			return sendErrorResponse(
				c,
				{ message: "No file uploaded" },
				StatusCodes.BAD_REQUEST,
			);
		}

		// Validate size (5MB)
		const MAX = 5 * 1024 * 1024;
		if (file.size > MAX) {
			return sendErrorResponse(
				c,
				{ message: "File exceeds 5MB limit" },
				StatusCodes.BAD_REQUEST,
			);
		}

		// Validate type
		const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
		if (!allowed.includes(file.type)) {
			return sendErrorResponse(
				c,
				{ message: `Invalid type '${file.type}'. Allowed: JPEG, PNG, WebP, GIF` },
				StatusCodes.BAD_REQUEST,
			);
		}

		const fileType = inferMime(file);
		const ext = fileType.split("/")[1] ?? "bin";
		const key = generateImageKey("feed", ext, authData.id.toString());

		await this.storage.upload({
			key,
			body: file,
			contentType: fileType,
		});

		const publicUrl = `${config.cdn.url}${key}`;

		return sendSuccessResponse(
			c,
			{ url: publicUrl, key },
			StatusCodes.CREATED,
		);
	};

	/** @info - Lesson video upload (MP4/MOV/WebM/M4V, up to 200 MB). */
	uploadVideo = async (c: Context) => {
		const formData = await c.req.formData();
		const file = formData.get("file") as File | null;

		const allowed = [
			"video/mp4",
			"video/quicktime",
			"video/webm",
			"video/x-m4v",
			"video/mpeg",
		];
		if (!file || !(file instanceof File)) {
			return sendErrorResponse(
				c,
				{ message: "Missing or invalid file for field 'file'" },
				StatusCodes.BAD_REQUEST,
			);
		}
		if (file.size > 200 * 1024 * 1024) {
			return sendErrorResponse(
				c,
				{ message: "File exceeds size limit of 200 MB" },
				StatusCodes.BAD_REQUEST,
			);
		}
		const fileType = inferMime(file);
		if (!allowed.includes(fileType)) {
			return sendErrorResponse(
				c,
				{ message: `Invalid file type '${fileType}'. Allowed: MP4, MOV, WebM, M4V, MPEG` },
				StatusCodes.BAD_REQUEST,
			);
		}

		const ext = file.name.split(".").pop() ?? file.type.split("/")[1] ?? "mp4";
		const safeName =
			file.name
				.replace(/\.[^.]+$/, "")
				.replace(/[^a-zA-Z0-9._-]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 60) || "lesson";
		const key = `images/files/general/${Date.now()}-${nanoid(6)}-${safeName}.${ext}`;

		await this.storage.upload({
			key,
			body: file,
			contentType: fileType,
		});

		const publicUrl = `${config.cdn.url}${key}`;
		return sendSuccessResponse(
			c,
			{ url: publicUrl, key, name: file.name },
			StatusCodes.CREATED,
		);
	};
}
