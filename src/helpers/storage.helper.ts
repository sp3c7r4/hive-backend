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

	// Handle arrays — convert each key to a full URL
	if (Array.isArray(s3Key)) {
		const urls = s3Key
			.filter((k) => typeof k === "string" && k.length > 0)
			.map((k) => (urlRegex.test(k) ? k : `${config.aws.s3Url}${k}`));
		return { ...doc, [field]: urls };
	}

	// Handle single string key
	if (!s3Key || urlRegex.test(s3Key)) return doc;

	const url = `${config.aws.s3Url}${s3Key}`;
	return { ...doc, [field]: url };
}

/**
 * @info Converts multiple fields on a document to S3 URLs at once.
 *       Accepts a string (single field) or array of strings (multiple fields).
 */
export function withPresignedUrls<T extends Record<string, any>>(
	doc: T,
	fields: string | string[],
): T {
	const fieldList = Array.isArray(fields) ? fields : [fields];
	let result = { ...doc };
	for (const field of fieldList) {
		result = withPresignedUrl(result, field);
	}
	return result;
}
