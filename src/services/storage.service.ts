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

interface UploadParams {
	key: string;
	body: Buffer | File;
	contentType: string;
}

interface PresignedUploadParams {
	key: string;
	contentType: string;
	expiresIn?: number;
}

interface PresignedDownloadParams {
	key: string;
	expiresIn?: number;
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
	}: UploadParams): Promise<PutObjectCommandOutput> => {
		const buffer =
			body instanceof File ? Buffer.from(await body.arrayBuffer()) : body;

		const command = new PutObjectCommand({
			Bucket: this.bucket,
			Key: key,
			Body: buffer,
			ContentType: contentType,
		});
		return await this.client.send(command);
	};

	generatePresignedUploadUrl = async ({
		key,
		contentType,
		expiresIn = TTL.IN_AN_HOUR,
	}: PresignedUploadParams): Promise<{
		url: string;
		key: string;
		bucket: string;
	}> => {
		const command = new PutObjectCommand({
			Bucket: this.bucket,
			Key: key,
			ContentType: contentType,
		});
		const url = await getSignedUrl(this.client, command, { expiresIn });
		return { url, key, bucket: this.bucket };
	};

	generatePresignedDownloadUrl = async ({
		key,
		expiresIn = TTL.IN_AN_HOUR,
	}: PresignedDownloadParams): Promise<string> => {
		const command = new GetObjectCommand({
			Bucket: this.bucket,
			Key: key,
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

	delete = async (key: string): Promise<DeleteObjectCommandOutput> => {
		const command = new DeleteObjectCommand({
			Bucket: this.bucket,
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
