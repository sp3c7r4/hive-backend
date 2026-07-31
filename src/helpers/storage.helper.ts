import type { GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { config } from "@/config";
import { urlRegex } from "@/constants";

export async function getRaw(
	res: GetObjectCommandOutput,
): Promise<ArrayBuffer> {
	return await new Response(res.Body as ReadableStream).arrayBuffer();
}

export function withPresignedUrl<T extends Record<string, any>>(
	doc: T,
	field: string = "avatar",
): T {
	const s3Key = doc?.[field];
	/** If there's no Key present in the image or it's a full url return the document */
	if (!s3Key || urlRegex.test(s3Key)) return doc;

	const url = `${config.aws.s3Url}${s3Key}`;
	return { ...doc, [field]: url };
}
