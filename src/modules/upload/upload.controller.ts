import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { nanoid } from "nanoid";
import { config } from "@/config";
import { DocumentMimeType } from "@/enums";
import { generateMediaKey } from "@/helpers/id-generators";
import type { ImageProfile } from "@/helpers/image.helper";
import {
	sendErrorResponse,
	sendSuccessResponse,
} from "@/helpers/response/send-response";
import {
	StorageService,
	UnreadableImageError,
} from "@/services/storage.service";
import { UPLOAD_MESSAGES } from "./upload.message";

/* @info - The presign route is the only place a client names a folder. It names
 * an allowlisted value, not a path: an unlisted value would let an authenticated
 * caller write into `assets/` or `certificates/`, which the app reads as its
 * own. */
const PRESIGN_FOLDERS: Record<string, { prefix: string }> = {
	videos: { prefix: "videos/lessons" },
	pptx: { prefix: "documents/decks" },
};
const PRESIGN_DEFAULT_PREFIX = "documents/uploads";

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
		const folderConfig = folder ? PRESIGN_FOLDERS[folder] : null;
		if (folder && !folderConfig) {
			return sendErrorResponse(
				c,
				{ message: UPLOAD_MESSAGES.FOLDER_NOT_ALLOWED },
				StatusCodes.BAD_REQUEST,
			);
		}
		const folderName = folder ?? "uploads";

		/* @info - Lesson videos are uploaded straight to S3 via this presigned
		 * URL; keep the declared content type honest at the gate. */
		if (folderName === "videos") {
			const allowedVideoTypes = [
				"video/mp4",
				"video/quicktime",
				"video/webm",
				"video/x-m4v",
				"video/mpeg",
			];
			if (!allowedVideoTypes.includes(contentType)) {
				return sendErrorResponse(
					c,
					{
						message: `Invalid file type '${contentType}'. Allowed: MP4, MOV, WebM, M4V, MPEG`,
					},
					StatusCodes.BAD_REQUEST,
				);
			}
		}

		/* @info - Lesson decks. .pptx only: the student's browser parses OOXML, and
		 * the legacy .ppt binary format is not something a client-side renderer can
		 * read. Keep the declared content type honest at the gate. */
		if (folderName === "pptx") {
			const allowedDeckTypes: readonly string[] = [DocumentMimeType.PPTX];
			if (!allowedDeckTypes.includes(contentType)) {
				return sendErrorResponse(
					c,
					{
						message: `Invalid file type '${contentType}'. Allowed: PPTX`,
					},
					StatusCodes.BAD_REQUEST,
				);
			}
		}

		const key = generateMediaKey(
			folderConfig?.prefix ?? PRESIGN_DEFAULT_PREFIX,
			ext,
			authData.id.toString(),
		);

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
			"application/vnd.ms-excel",
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			"application/vnd.ms-powerpoint",
			"application/vnd.openxmlformats-officedocument.presentationml.presentation",
			"image/jpeg",
			"image/png",
			"image/gif",
			"image/webp",
			"audio/webm",
			"audio/mp4",
			"audio/x-m4a",
			"audio/ogg",
			"audio/mpeg",
			"video/mp4",
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
				{
					message: `Invalid file type '${fileType}'. Allowed: PDF, DOC, DOCX, XLS, XLSX, PPT, PPTX, JPEG, PNG, GIF, WebP, audio`,
				},
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
		const key = `documents/attachments/${c.get("authData")?.id ?? "general"}/${Date.now()}-${nanoid(6)}-${safeName}.${ext}`;

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
		/* @info - A community cover set after creation arrives here rather than
		 * through the community's multipart route (that one takes JSON), so the
		 * caller names its purpose and both cover paths agree. */
		const purpose = (formData.get("purpose") as string | null) ?? "feed";
		if (purpose !== "feed" && purpose !== "cover") {
			return sendErrorResponse(
				c,
				{ message: UPLOAD_MESSAGES.FOLDER_NOT_ALLOWED },
				StatusCodes.BAD_REQUEST,
			);
		}

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
				{
					message: `Invalid type '${file.type}'. Allowed: JPEG, PNG, WebP, GIF`,
				},
				StatusCodes.BAD_REQUEST,
			);
		}

		const fileType = inferMime(file);
		const ext = fileType.split("/")[1] ?? "bin";
		const profile: ImageProfile = purpose === "cover" ? "cover" : "feed";
		const key = generateMediaKey(
			purpose === "cover" ? "images/covers" : "images/feed",
			ext,
			authData?.id?.toString(),
		);

		/* @info - The upload answers with the key it wrote: an image derivative
		 * lands with a .webp extension. */
		let written = key;
		try {
			const result = await this.storage.upload({
				key,
				body: file,
				contentType: fileType,
				imageProfile: profile,
			});
			written = result.key;
		} catch (err) {
			if (!(err instanceof UnreadableImageError)) throw err;
			return sendErrorResponse(
				c,
				{ message: UPLOAD_MESSAGES.UNREADABLE_IMAGE },
				StatusCodes.BAD_REQUEST,
			);
		}

		const publicUrl = `${config.cdn.url}${written}`;

		return sendSuccessResponse(
			c,
			{ url: publicUrl, key: written },
			StatusCodes.CREATED,
		);
	};

	/** @info - Lesson video upload (MP4/MOV/WebM/M4V, no size cap). */
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
		/* @info - No size cap: lesson videos can be arbitrarily large (the
		 * reverse proxy must allow the body; type validation below is the
		 * gate). */
		const fileType = inferMime(file);
		if (!allowed.includes(fileType)) {
			return sendErrorResponse(
				c,
				{
					message: `Invalid file type '${fileType}'. Allowed: MP4, MOV, WebM, M4V, MPEG`,
				},
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
		const key = `videos/lessons/${c.get("authData")?.id ?? "general"}/${Date.now()}-${nanoid(6)}-${safeName}.${ext}`;

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
