import type { Context, Next } from "hono";
import { StatusCodes } from "http-status-codes";
import { generateImageKey } from "@/helpers/id-generators";
import { sendErrorResponse } from "@/helpers/response/send-response";
import { StorageService } from "@/services/storage.service";

interface UploadOptions {
	fieldName: string;
	sizeLimit?: number;
	allowedTypes?: string[];
	optional?: boolean;
}

type SingleUploadOptions = UploadOptions &
	(
		| { fallback?: string[]; optional?: never }
		| { fallback?: never; optional?: boolean }
	);

interface UploadedFile {
	key: string;
	originalName: string;
	size: number;
	mimeType: string;
}

/**
 * @class FileUploadMiddleware
 * @description Hono middleware handler for single and multiple file uploads.
 * Validates files, uploads them to storage, and attaches results to the context.
 */
export class FileUploadMiddleware {
	private static instance: FileUploadMiddleware;

	/** @private Storage service for persisting uploaded files */
	private readonly storageService: StorageService;

	private constructor() {
		this.storageService = StorageService.getInstance();
	}

	/**
	 * @returns {FileUploadMiddleware} Singleton instance
	 */
	static getInstance(): FileUploadMiddleware {
		if (!this.instance) this.instance = new FileUploadMiddleware();
		return this.instance;
	}

	/**
	 * @description Formats byte size into a human-readable string
	 * @param {number} bytes - Raw byte count
	 * @returns {string} Formatted size string (e.g. "2.4MB", "512KB", "128B")
	 */
	private formatSize(bytes: number): string {
		if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
		if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
		return `${bytes}B`;
	}

	/**
	 * @description Validates a file against the provided upload options
	 * @param {unknown} file - The file to validate
	 * @param {UploadOptions} options - Validation constraints
	 * @returns {string | null} Error message if invalid, null if valid
	 */
	private validateFile(file: unknown, options: UploadOptions): string | null {
		if (!file || !(file instanceof File)) {
			return `Missing or invalid file for field '${options.fieldName}'`;
		}
		if (options.sizeLimit && file.size > options.sizeLimit) {
			return `File exceeds size limit of ${this.formatSize(options.sizeLimit)}`;
		}
		if (options.allowedTypes && !options.allowedTypes.includes(file.type)) {
			return `Invalid file type '${file.type}'. Allowed: ${options.allowedTypes.join(", ")}`;
		}
		return null;
	}

	/**
	 * @description Resolves file extension and uploads to storage
	 * @param {File} file - The validated file
	 * @param {string} fieldName - Form field name used for key generation
	 * @param {string} userId - Authenticated user's ID
	 * @returns {Promise<UploadedFile | null>} Uploaded file metadata, or null if MIME type unrecognized
	 */
	private async processUpload(
		file: File,
		fieldName: string,
		userId: string,
	): Promise<UploadedFile | null> {
		const ext = file.type.split("/")[1] ?? "bin";
		const key = generateImageKey(fieldName, ext, userId);
		await this.storageService.upload({
			key,
			body: file,
			contentType: file.type,
		});

		return {
			key,
			originalName: file.name,
			size: file.size,
			mimeType: file.type,
		};
	}

	/**
	 * @description Middleware for handling a single file upload.
	 * Sets `uploadedFile` on the Hono context upon success.
	 * @param {UploadOptions} options - Upload constraints
	 * @returns {(c: Context, next: Next) => Promise<Response | void>} Hono middleware
	 */
	single = (options: SingleUploadOptions) => {
		return async (c: Context, next: Next) => {
			const formData = await c.req.formData();
			const file = formData.get(options.fieldName) as File;

			// No file provided — use fallback if available
			if (!file || !(file instanceof File)) {
				if (options.fallback?.length) {
					const key =
						options.fallback[
							Math.floor(Math.random() * options.fallback.length)
						];
					console.log({
           	key,
           	originalName: "default",
           	size: 0,
           	mimeType: "",
          })
          c.set("uploadedFile", {
						key,
						originalName: "default",
						size: 0,
						mimeType: "",
					});
					await next();
					return;
				}

				if (options.optional) {
					await next();
					return;
				}

				return sendErrorResponse(
					c,
					{
						message: `Missing or invalid file for field '${options.fieldName}'`,
					},
					StatusCodes.BAD_REQUEST,
				);
			}

			const error = this.validateFile(file, options);
			if (error) {
				return sendErrorResponse(
					c,
					{ message: error },
					StatusCodes.BAD_REQUEST,
				);
			}

			const userId = c.get("authData")?._id;
			const uploaded = await this.processUpload(
				file,
				options.fieldName,
				userId,
			);

			if (!uploaded) {
				return sendErrorResponse(
					c,
					{ message: `Unrecognized MIME type '${file.type}'` },
					StatusCodes.BAD_REQUEST,
				);
			}

			c.set("uploadedFile", uploaded);
			await next();
		};
	};

	/**
	 * @description Middleware for handling multiple file uploads.
	 * Sets `uploadedFiles` on the Hono context upon success.
	 * @param {UploadOptions & { maxCount?: number }} options - Upload constraints with optional max file count
	 * @returns {(c: Context, next: Next) => Promise<Response | void>} Hono middleware
	 */
	multiple = (options: UploadOptions & { maxCount?: number }) => {
		return async (c: Context, next: Next) => {
			const formData = await c.req.formData();
			const files = formData.getAll(options.fieldName);

			if (!files.length) {
				return sendErrorResponse(
					c,
					{ message: `No files provided for field '${options.fieldName}'` },
					StatusCodes.BAD_REQUEST,
				);
			}

			if (options.maxCount && files.length > options.maxCount) {
				return sendErrorResponse(
					c,
					{ message: `Too many files. Maximum is ${options.maxCount}` },
					StatusCodes.BAD_REQUEST,
				);
			}

			for (const file of files) {
				const error = this.validateFile(file, options);
				if (error) {
					return sendErrorResponse(
						c,
						{ message: error },
						StatusCodes.BAD_REQUEST,
					);
				}
			}

			const userId = c.get("authData")?._id;
			const uploaded: UploadedFile[] = [];

			for (const file of files as File[]) {
				const result = await this.processUpload(
					file,
					options.fieldName,
					userId,
				);
				if (!result) {
					return sendErrorResponse(
						c,
						{ message: `Unrecognized MIME type '${file.type}'` },
						StatusCodes.BAD_REQUEST,
					);
				}
				uploaded.push(result);
			}

			c.set("uploadedFiles", uploaded);
			await next();
		};
	};

	singleBuffer = (
		options: Omit<UploadOptions, "optional">,
		fn: (file: File, c: Context) => Promise<any> | any,
	) => {
		return async (c: Context, next: Next) => {
			const formData = await c.req.formData();
			const file = formData.get(options.fieldName) as File;

			if (!file || !(file instanceof File))
				return sendErrorResponse(
					c,
					{ message: "Invalid file" },
					StatusCodes.BAD_REQUEST,
				);
			const error = this.validateFile(file, options);
			if (error)
				return sendErrorResponse(
					c,
					{ message: error },
					StatusCodes.BAD_REQUEST,
				);

			// const fileBuffer = Buffer.from(await file.arrayBuffer());
			await fn(file, c);
			await next();
		};
	};
}

// const storage = multer.memoryStorage();
// const multerUpload = multer({ storage });

// export const BufferUpload = {
// 	single: (key: string) => {
// 		return async (c: Context, n: Next) => {
// 			multerUpload.single(key);
// 			await n();
// 		};
// 	},
// 	multiple: {},
// };
