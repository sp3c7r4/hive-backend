import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendErrorResponse, sendSuccessResponse } from "@/helpers/response/send-response";
import { StorageService } from "@/services/storage.service";
import { generateImageKey } from "@/helpers/id-generators";

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
		const { contentType, filename } = await c.req.json();

		const ext = filename.split(".").pop() ?? "bin";
		const key = generateImageKey("uploads", ext, authData.id.toString());

		const result = await this.storage.generatePresignedUploadUrl({
			key,
			contentType,
		});

		return sendSuccessResponse(c, result, StatusCodes.CREATED);
	};

	presignedDownload = async (c: Context) => {
		const { key } = c.req.param();

		const url = await this.storage.generatePresignedDownloadUrl({ key });

		return sendSuccessResponse(c, { url });
	};
}
