import {
	DeleteObjectCommand,
	type DeleteObjectCommandOutput,
	GetObjectCommand,
	type GetObjectCommandOutput,
	HeadObjectCommand,
	PutObjectCommand,
	type PutObjectCommandOutput,
	S3Client,
	type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "@/config";
import { TTL } from "@/constants";
import type { ImageProfile } from "@/helpers/image.helper";
import {
	derivativeMetadata,
	toWebp,
	withWebpExtension,
} from "@/helpers/image.helper";

interface UploadParams {
	key: string;
	body: Buffer | File;
	contentType: string;
	/** @info - Name a profile and the object is stored as a WebP derivative of it
	 *  (resized, EXIF-rotated, metadata dropped, cacheable). Absent means store the
	 *  bytes exactly as given, which is what private or already-processed content
	 *  needs. */
	imageProfile?: ImageProfile;
	/** @info - Only meaningful when the bytes are stored raw; a derivative carries
	 *  its own cache header. */
	cacheControl?: string;
}

interface PresignedUploadParams {
	key: string;
	contentType: string;
	expiresIn?: number;
	cacheControl?: string;
}

/** @info - The upload could not be read as an image. The caller answers 400:
 *  storing it would put something the app cannot render behind a public URL. */
export class UnreadableImageError extends Error {
	constructor() {
		super("unreadable image");
		this.name = "UnreadableImageError";
	}
}

interface PresignedDownloadParams {
	key: string;
	expiresIn?: number;
	/** @info - Recordings live in their own private bucket (spec fact 9), so the caller names
	 *  it rather than a second S3 service existing for one bucket difference. */
	bucket?: string;
	/** @info - Set for a download: `attachment; filename="..."` becomes an overridable
	 *  response header on the signed GET, so the object saves instead of streaming. */
	responseContentDisposition?: string;
}

export class StorageService {
	private static instance: StorageService | null = null;
	private readonly client: S3Client;
	private readonly bucket: string;

	static getInstance(): StorageService {
		if (!StorageService.instance) {
			StorageService.instance = new StorageService();
		}
		return StorageService.instance;
	}

	private constructor() {
		const clientConfig: S3ClientConfig = {
			region: config.aws.region,
			credentials: {
				accessKeyId: config.aws.accessKeyId,
				secretAccessKey: config.aws.secretAccessKey,
			},
		};

		if (config.aws.s3Endpoint) {
			clientConfig.endpoint = config.aws.s3Endpoint;
			clientConfig.forcePathStyle = true;
		}

		this.client = new S3Client(clientConfig);
		this.bucket = config.aws.s3Bucket;
	}

	upload = async ({
		key,
		body,
		contentType,
		imageProfile,
		cacheControl,
	}: UploadParams): Promise<PutObjectCommandOutput & { key: string }> => {
		const buffer =
			body instanceof File ? Buffer.from(await body.arrayBuffer()) : body;

		/* @info - A derivative is produced here, in the process that already holds
		 * the bytes, rather than in a separate Lambda: one command, one object, and
		 * the original never lands in the bucket. */
		const derived = imageProfile ? await toWebp(buffer, imageProfile) : null;
		if (imageProfile && !derived) throw new UnreadableImageError();
		const metadata = imageProfile ? derivativeMetadata(imageProfile) : null;

		/* @info - The key that was actually written. A derivative lands under a new
		 * extension, and the database stores keys rather than URLs, so the caller
		 * has to be told which one exists. */
		const writtenKey = derived ? withWebpExtension(key) : key;

		const command = new PutObjectCommand({
			Bucket: this.bucket,
			Key: writtenKey,
			Body: derived ?? buffer,
			ContentType: metadata?.contentType ?? contentType,
			...(metadata?.cacheControl || cacheControl
				? { CacheControl: metadata?.cacheControl ?? cacheControl }
				: {}),
		});
		const output = await this.client.send(command);
		return { ...output, key: writtenKey };
	};

	generatePresignedUploadUrl = async ({
		key,
		contentType,
		expiresIn = TTL.IN_AN_HOUR,
		cacheControl,
	}: PresignedUploadParams): Promise<{
		url: string;
		key: string;
		bucket: string;
	}> => {
		const command = new PutObjectCommand({
			Bucket: this.bucket,
			Key: key,
			ContentType: contentType,
			...(cacheControl ? { CacheControl: cacheControl } : {}),
		});
		const url = await getSignedUrl(this.client, command, { expiresIn });
		return { url, key, bucket: this.bucket };
	};

	generatePresignedDownloadUrl = async ({
		key,
		expiresIn = TTL.IN_AN_HOUR,
		bucket = this.bucket,
		responseContentDisposition,
	}: PresignedDownloadParams): Promise<string> => {
		const command = new GetObjectCommand({
			Bucket: bucket,
			Key: key,
			...(responseContentDisposition
				? { ResponseContentDisposition: responseContentDisposition }
				: {}),
		});
		return getSignedUrl(this.client, command, { expiresIn });
	};

	get = async (key: string): Promise<GetObjectCommandOutput> => {
		const command = new GetObjectCommand({
			Bucket: this.bucket,
			Key: key,
		});
		return this.client.send(command);
	};

	/**
	 * @info - Deletes one object. The bucket defaults to the media bucket every other path
	 * uses; recordings live in their own bucket (and have their own 90-day lifecycle), so the
	 * caller passes it rather than a second service class existing for one bucket difference.
	 */
	delete = async (
		key: string,
		bucket: string = this.bucket,
	): Promise<DeleteObjectCommandOutput> => {
		const command = new DeleteObjectCommand({
			Bucket: bucket,
			Key: key,
		});
		return this.client.send(command);
	};

	exists = async (key: string): Promise<boolean> => {
		const command = new HeadObjectCommand({
			Bucket: this.bucket,
			Key: key,
		});

		return !!this.client.send(command);
	};
}
