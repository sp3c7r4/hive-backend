/**
 * @info - Image derivatives for uploaded media. One place decides what a
 * stored cover, avatar, signature or feed image looks like, so every upload
 * path produces the same artefact and the bucket never holds a 4 MB phone
 * photo that a card renders at 400px.
 *
 * sharp is the only image library in the project; libvips does the work in
 * native code, which is why these are async and why the pixel ceiling exists.
 */

import sharp from "sharp";

/** Which derivative to produce. The key is the profile, the value its recipe. */
export type ImageProfile = "cover" | "avatar" | "signature" | "feed";

export const IMAGE_PROFILES: Record<
	ImageProfile,
	{ width: number; quality: number }
> = {
	cover: { width: 1200, quality: 80 },
	avatar: { width: 400, quality: 80 },
	signature: { width: 800, quality: 80 },
	feed: { width: 1200, quality: 80 },
};

/* @info - 40 MP admits an 8K photo (33 MP) and refuses the classic
 * decompression bomb: sharp's own default is 268 MP, which it will happily try
 * to allocate. */
export const MAX_INPUT_PIXELS = 40_000_000;

/**
 * @info - Decode, rotate by EXIF orientation, cap the width and encode WebP.
 * Returns null when the bytes are not a decodable image or are larger than
 * MAX_INPUT_PIXELS: the caller answers 400 rather than storing something the
 * app cannot render. Metadata is not carried over, so EXIF (including GPS)
 * does not travel with the derivative.
 */
export async function toWebp(
	body: Buffer,
	profile: ImageProfile,
): Promise<Buffer | null> {
	const { width, quality } = IMAGE_PROFILES[profile];
	try {
		return await sharp(body, { limitInputPixels: MAX_INPUT_PIXELS })
			.rotate()
			.resize({ width, withoutEnlargement: true })
			.webp({ quality })
			.toBuffer();
	} catch {
		return null;
	}
}

/** @info - The object metadata that goes with a stored derivative. */
export const derivativeMetadata = (profile: ImageProfile) => {
	void profile;
	return {
		contentType: "image/webp",
		/* @info - Keys are unique per upload, so a year is safe. Immutable is
		 * deliberately not set: objects can be overwritten in place and the
		 * distribution invalidates them by path after upload. */
		cacheControl: "public, max-age=31536000",
	};
};

/** @info - `images/covers/42/abc.jpg` -> `images/covers/42/abc.webp`, on the
 * file name only (a dotted folder name must not be touched). */
export const withWebpExtension = (key: string): string => {
	const slash = key.lastIndexOf("/");
	const head = key.slice(0, slash + 1);
	const name = key.slice(slash + 1);
	const dot = name.lastIndexOf(".");
	return `${head}${dot > 0 ? name.slice(0, dot) : name}.webp`;
};
