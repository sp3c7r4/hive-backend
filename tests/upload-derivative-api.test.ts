import { S3Client } from "@aws-sdk/client-s3";
import { Hono } from "hono";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { CacheService } from "@/services/cache.service";
import { JwtService } from "@/services/jwt.service";

/**
 * @info - Uploaded images leave the API as WebP derivatives under a media-class
 * prefix, with a cache header, or they are refused with a 400 and nothing is
 * written.
 *
 * The S3 client is stubbed at `send`, not the StorageService: the real
 * conversion runs (sharp, the profiles, the key naming) and the test asserts the
 * PutObjectCommand that would have gone to S3. That is the thing under test, and
 * it needs no bucket and no credentials.
 *
 * Requires local Postgres + Redis, like every DB-backed test here.
 */

const AUTH_ID = "auth:upload-derivative";
const EMAIL = "upload.derivative@hive.test";

let db: ReturnType<typeof getDb>;
let app: Hono;
let token: string;
let userId: number;

const sql = async (statement: string) => {
	const result = await db.execute(statement);
	return result.rows as any[];
};
const one = async (statement: string) => (await sql(statement))[0];

/** A solid-colour JPEG of the given size, built in memory. */
const jpeg = (width: number, height: number) =>
	sharp({
		create: {
			width,
			height,
			channels: 3,
			background: { r: 30, g: 90, b: 160 },
		},
	})
		.jpeg()
		.toBuffer();

const form = (field: string, body: Buffer, name: string, type: string) => {
	const fd = new FormData();
	fd.append(field, new File([new Uint8Array(body)], name, { type }));
	return fd;
};

const auth = () => ({ Authorization: `Bearer ${token}` });

/* @info - Every PUT the service would make, captured instead of sent. */
const puts: {
	Key: string;
	ContentType?: string;
	CacheControl?: string;
	Body: any;
}[] = [];
let sendSpy: any;

/* @info - `expect(puts).toHaveLength(1)` always precedes a `lastPut()` read, so the
 * non-null assertion states what the test just proved. */
const lastPut = () => puts[puts.length - 1]!;

beforeAll(async () => {
	await connectPostgresDB(() => {});
	db = getDb();

	/* @info - Clean up by email, not by the id captured in beforeAll: a failing
	 * beforeAll leaves that id undefined and turns one error into two. */
	await sql(
		`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE lower(email) = '${EMAIL}')`,
	);
	await sql(`DELETE FROM users WHERE lower(email) = '${EMAIL}'`);
	userId = (
		await one(
			`INSERT INTO users (first_name, last_name, email, onboarded) VALUES ('Upload', 'Tester', '${EMAIL}', true) RETURNING id`,
		)
	).id as number;
	await sql(
		`INSERT INTO user_roles (user_id, role) VALUES (${userId}, 'instructor')`,
	);

	const { testApp } = await import("./setup");
	app = testApp;
	token = JwtService.getInstance().generateToken(AUTH_ID);
	await CacheService.getInstance().set(AUTH_ID, {
		id: userId,
		email: EMAIL,
		firstName: "Upload",
		roles: ["instructor"],
		isAuthenticated: true,
	});

	sendSpy = vi
		.spyOn(S3Client.prototype, "send")
		.mockImplementation(async (command: any) => {
			puts.push(command.input);
			return {} as any;
		});
});

afterAll(async () => {
	sendSpy?.mockRestore();
	/* @info - Clean up by email, not by the id captured in beforeAll: a failing
	 * beforeAll leaves that id undefined and turns one error into two. */
	await sql(
		`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE lower(email) = '${EMAIL}')`,
	);
	await sql(`DELETE FROM users WHERE lower(email) = '${EMAIL}'`);
});

describe("avatar upload (PUT /user/avatar)", () => {
	it("stores a WebP derivative under images/avatars with a one-year cache header", async () => {
		puts.length = 0;
		const res = await app.request("/api/v1/user/avatar", {
			method: "PUT",
			headers: auth(),
			body: form("avatar", await jpeg(3000, 2000), "me.jpg", "image/jpeg"),
		});
		expect(res.status).toBe(200);

		const put = lastPut();
		expect(put.Key).toMatch(
			new RegExp(`^images/avatars/${userId}/[\\w-]+\\.webp$`),
		);
		expect(put.ContentType).toBe("image/webp");
		expect(put.CacheControl).toBe("public, max-age=31536000");

		/* The bytes really are a WebP, capped at the avatar width. */
		const meta = await sharp(put.Body as Buffer).metadata();
		expect(meta.format).toBe("webp");
		expect(meta.width).toBe(400);

		/* The row and the response carry the key that was written, not the one asked for. */
		const row = await one(`SELECT avatar_url FROM users WHERE id = ${userId}`);
		expect(row.avatar_url).toBe(put.Key);
		const body = (await res.json()) as any;
		expect(body.data.user.avatarUrl).toContain(put.Key);
	});

	it("refuses bytes that are not an image, with nothing written", async () => {
		puts.length = 0;
		const res = await app.request("/api/v1/user/avatar", {
			method: "PUT",
			headers: auth(),
			body: form(
				"avatar",
				Buffer.from("this is not an image, it only claims to be one"),
				"fake.jpg",
				"image/jpeg",
			),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).error.message).toContain(
			"could not be read",
		);
		expect(puts).toHaveLength(0);
	});

	it("still refuses a file over the 5 MB cap, and a type outside the allowlist", async () => {
		puts.length = 0;
		const tooBig = await app.request("/api/v1/user/avatar", {
			method: "PUT",
			headers: auth(),
			body: form(
				"avatar",
				Buffer.alloc(5 * 1024 * 1024 + 1),
				"big.png",
				"image/png",
			),
		});
		expect(tooBig.status).toBe(400);
		expect(((await tooBig.json()) as any).error.message).toContain(
			"size limit",
		);

		const wrongType = await app.request("/api/v1/user/avatar", {
			method: "PUT",
			headers: auth(),
			body: form(
				"avatar",
				Buffer.from("%PDF-1.4"),
				"cv.pdf",
				"application/pdf",
			),
		});
		expect(wrongType.status).toBe(400);
		expect(((await wrongType.json()) as any).error.message).toContain(
			"Invalid file type",
		);
		expect(puts).toHaveLength(0);
	});
});

describe("feed image and cover (POST /upload/feed-image)", () => {
	it("files a feed image under images/feed as WebP", async () => {
		puts.length = 0;
		const res = await app.request("/api/v1/upload/feed-image", {
			method: "POST",
			headers: auth(),
			body: form("file", await jpeg(2400, 1600), "post.jpg", "image/jpeg"),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as any;
		expect(lastPut().Key).toMatch(
			new RegExp(`^images/feed/${userId}/[\\w-]+\\.webp$`),
		);
		expect(body.data.key).toBe(lastPut().Key);
		expect(body.data.url).toContain(lastPut().Key);
	});

	it("files a cover under images/covers when the caller says so", async () => {
		puts.length = 0;
		const fd = form("file", await jpeg(1200, 800), "cover.jpg", "image/jpeg");
		fd.append("purpose", "cover");
		const res = await app.request("/api/v1/upload/feed-image", {
			method: "POST",
			headers: auth(),
			body: fd,
		});
		expect(res.status).toBe(201);
		expect(lastPut().Key).toMatch(
			new RegExp(`^images/covers/${userId}/[\\w-]+\\.webp$`),
		);
	});

	it("refuses an unknown purpose", async () => {
		puts.length = 0;
		const fd = form("file", await jpeg(400, 400), "x.jpg", "image/jpeg");
		fd.append("purpose", "certificates");
		const res = await app.request("/api/v1/upload/feed-image", {
			method: "POST",
			headers: auth(),
			body: fd,
		});
		expect(res.status).toBe(400);
		expect(puts).toHaveLength(0);
	});
});

describe("presign folders (POST /upload/presigned)", () => {
	const presign = (body: unknown) =>
		app.request("/api/v1/upload/presigned", {
			method: "POST",
			headers: { ...auth(), "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

	it("keeps the client contract for videos and decks, under the new prefixes", async () => {
		const video = await presign({
			contentType: "video/mp4",
			filename: "lesson.mp4",
			folder: "videos",
		});
		expect(video.status).toBe(201);
		const videoBody = (await video.json()) as any;
		expect(videoBody.data.key).toMatch(
			new RegExp(`^videos/lessons/${userId}/[\\w-]+\\.mp4$`),
		);

		const deck = await presign({
			contentType:
				"application/vnd.openxmlformats-officedocument.presentationml.presentation",
			filename: "deck.pptx",
			folder: "pptx",
		});
		expect(deck.status).toBe(201);
		expect(((await deck.json()) as any).data.key).toMatch(
			new RegExp(`^documents/decks/${userId}/[\\w-]+\\.pptx$`),
		);
	});

	it("refuses a folder it does not know, so nobody writes into assets/ or certificates/", async () => {
		for (const folder of ["assets", "certificates", "../../assets"]) {
			const res = await presign({
				contentType: "image/png",
				filename: "logo.png",
				folder,
			});
			expect(res.status).toBe(400);
			expect(((await res.json()) as any).error.message).toContain(
				"Unknown upload folder",
			);
		}
	});
});

describe("raw uploads keep their bytes (submissions, attachments, videos)", () => {
	it("stores submission files unchanged, under documents/submissions, with no cache header", async () => {
		/* @info - Mounted with the same options as `POST /submissions`, so the
		 * middleware path is exercised end to end without building a lesson and an
		 * enrollment around it. */
		const { FileUploadMiddleware } = await import("@/middlewares/upload");
		const submissions = new Hono<{
			Variables: { authData: { id: number }; uploadedFiles: unknown };
		}>();
		submissions.use("*", async (c, next) => {
			c.set("authData", { id: userId });
			await next();
		});
		submissions.post(
			"/",
			FileUploadMiddleware.getInstance().multiple({
				fieldName: "files",
				keyFolder: "documents/submissions",
				optional: true,
				sizeLimit: 10 * 1024 * 1024,
				allowedTypes: ["application/pdf", "image/jpeg", "image/png"],
			}),
			(c) => c.json({ files: c.get("uploadedFiles") }),
		);

		puts.length = 0;
		const first = await jpeg(2000, 2000);
		const second = Buffer.from("%PDF-1.4 student work");
		const fd = new FormData();
		fd.append(
			"files",
			new File([new Uint8Array(first)], "work.jpg", { type: "image/jpeg" }),
		);
		fd.append(
			"files",
			new File([new Uint8Array(second)], "notes.pdf", {
				type: "application/pdf",
			}),
		);

		const res = await submissions.request("http://localhost/", {
			method: "POST",
			body: fd,
		});
		expect(res.status).toBe(200);
		expect(puts).toHaveLength(2);
		for (const put of puts) {
			expect(put.Key).toMatch(new RegExp(`^documents/submissions/${userId}/`));
			expect(put.CacheControl).toBeUndefined();
		}
		/* Byte for byte: a submitted file is evidence, not a rendering. */
		expect((puts[0]!.Body as Buffer).equals(first)).toBe(true);
		expect((puts[1]!.Body as Buffer).equals(second)).toBe(true);
	});

	it("stores a lesson video under videos/lessons", async () => {
		puts.length = 0;
		const res = await app.request("/api/v1/upload/video", {
			method: "POST",
			headers: auth(),
			body: form(
				"file",
				Buffer.from("0000001c667479706d703432"),
				"lesson.mp4",
				"video/mp4",
			),
		});
		expect(res.status).toBe(201);
		expect(lastPut().Key).toMatch(new RegExp(`^videos/lessons/${userId}/`));
		expect(lastPut().CacheControl).toBeUndefined();
	});

	it("stores a signature under images/signatures, unchanged", async () => {
		puts.length = 0;
		const png = await sharp({
			create: { width: 300, height: 120, channels: 4, background: "#fff" },
		})
			.png()
			.toBuffer();
		const res = await app.request("/api/v1/user/signature", {
			method: "PUT",
			headers: auth(),
			body: form("signature", png, "sig.png", "image/png"),
		});
		expect([200, 201]).toContain(res.status);
		expect(lastPut().Key).toMatch(
			new RegExp(`^images/signatures/${userId}/[\\w-]+\\.png$`),
		);
		expect((lastPut().Body as Buffer).equals(png)).toBe(true);
	});
});
