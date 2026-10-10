import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
	derivativeMetadata,
	IMAGE_PROFILES,
	MAX_INPUT_PIXELS,
	toWebp,
	withWebpExtension,
} from "@/helpers/image.helper";

/** A solid-colour JPEG of the given size, built in memory: no fixture files. */
const jpeg = (width: number, height: number, orientation?: number) => {
	let pipeline = sharp({
		create: {
			width,
			height,
			channels: 3,
			background: { r: 200, g: 120, b: 40 },
		},
	}).jpeg();
	if (orientation) pipeline = pipeline.withMetadata({ orientation });
	return pipeline.toBuffer();
};

const rgbaPng = (width: number, height: number) =>
	sharp({
		create: {
			width,
			height,
			channels: 4,
			background: { r: 240, g: 177, b: 0, alpha: 0.5 },
		},
	})
		.png()
		.toBuffer();

describe("toWebp", () => {
	it("converts a 3000x2000 JPEG to a WebP capped at the cover width and no taller than its aspect", async () => {
		const out = await toWebp(await jpeg(3000, 2000), "cover");
		expect(out).not.toBeNull();
		const meta = await sharp(out as Buffer).metadata();
		expect(meta.format).toBe("webp");
		expect(meta.width).toBe(IMAGE_PROFILES.cover.width);
		expect(meta.height).toBe(
			Math.round((2000 / 3000) * IMAGE_PROFILES.cover.width),
		);
	});

	it("uses each profile's own width", async () => {
		for (const profile of ["cover", "avatar", "signature", "feed"] as const) {
			const out = await toWebp(await jpeg(3000, 3000), profile);
			const meta = await sharp(out as Buffer).metadata();
			expect(meta.width).toBe(IMAGE_PROFILES[profile].width);
		}
	});

	it("never enlarges a small image", async () => {
		const out = await toWebp(await jpeg(200, 150), "avatar");
		const meta = await sharp(out as Buffer).metadata();
		expect(meta.width).toBe(200);
		expect(meta.height).toBe(150);
	});

	it("applies EXIF orientation, so a rotated phone photo is stored upright", async () => {
		/* EXIF orientation 6 means "rotate 90° clockwise on display": the stored
		 * pixels are 600x300 and the upright image is 300x600. */
		const out = await toWebp(await jpeg(600, 300, 6), "cover");
		const meta = await sharp(out as Buffer).metadata();
		expect(meta.width).toBe(300);
		expect(meta.height).toBe(600);
		expect(meta.orientation).toBeUndefined();
	});

	it("keeps transparency, so a PNG avatar does not come back with a black plate", async () => {
		const out = await toWebp(await rgbaPng(500, 500), "avatar");
		const meta = await sharp(out as Buffer).metadata();
		expect(meta.format).toBe("webp");
		expect(meta.hasAlpha).toBe(true);
	});

	it("strips metadata, so the GPS coordinates in a phone photo do not travel with it", async () => {
		const withExif = await sharp({
			create: { width: 900, height: 900, channels: 3, background: "#333" },
		})
			.withMetadata({ exif: { IFD0: { Copyright: "hive-test" } } })
			.jpeg()
			.toBuffer();
		const out = await toWebp(withExif, "cover");
		const meta = await sharp(out as Buffer).metadata();
		expect(meta.exif).toBeUndefined();
	});

	it("refuses an image above the pixel ceiling instead of decoding it", async () => {
		/* 6500x6300 is 40.95 MP, just over the 40 MP ceiling. Solid colour, so the
		 * JPEG itself stays small. */
		const bomb = await jpeg(6500, 6300);
		expect(6500 * 6300).toBeGreaterThan(MAX_INPUT_PIXELS);
		expect(await toWebp(bomb, "cover")).toBeNull();
	});

	it("refuses bytes that are not an image", async () => {
		expect(
			await toWebp(Buffer.from("this is not an image"), "cover"),
		).toBeNull();
		expect(await toWebp(Buffer.alloc(0), "cover")).toBeNull();
	});

	it("records the HEIC answer: this runtime decodes AVIF only, so image/heic stays refused", () => {
		/* Verified capability flag, not documentation. sharp's prebuilt libvips has
		 * HEIF support for AVIF only (no HEVC/HEIC decoder), so extending the upload
		 * allowlist to image/heic would accept a file we cannot convert. */
		expect(sharp.format.heif.input.fileSuffix).toEqual([".avif"]);
	});
});

describe("derivativeMetadata", () => {
	it("is WebP with a one-year public cache, for every profile", () => {
		for (const profile of ["cover", "avatar", "signature", "feed"] as const) {
			expect(derivativeMetadata(profile)).toEqual({
				contentType: "image/webp",
				cacheControl: "public, max-age=31536000",
			});
		}
	});
});

describe("withWebpExtension", () => {
	it("replaces the extension of the file name only", () => {
		expect(withWebpExtension("images/covers/42/abc-123.jpg")).toBe(
			"images/covers/42/abc-123.webp",
		);
		expect(withWebpExtension("images/a.b/42/abc.png")).toBe(
			"images/a.b/42/abc.webp",
		);
	});

	it("appends the extension when the key has none", () => {
		expect(withWebpExtension("images/covers/42/abc")).toBe(
			"images/covers/42/abc.webp",
		);
	});
});
