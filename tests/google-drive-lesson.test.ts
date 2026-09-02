import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { lessons, type NewLesson } from "@/modules/courses/course.model";
import { CourseService } from "@/modules/courses/course.service";

/**
 * @info - Service-level validation for the google_drive lesson type.
 * Creates real rows in a throwaway module and cleans them up.
 */
describe("CourseService google_drive lesson validation", () => {
	const service = CourseService.getInstance();
	let db: ReturnType<typeof getDb>;

	beforeAll(async () => {
		await connectPostgresDB(() => {});
		db = getDb();
	});

	const validLink =
		"https://drive.google.com/file/d/TESTDRIVE1/view?usp=sharing";

	let moduleId: number;
	const lessonIds: number[] = [];

	it("creates a google_drive lesson with a valid link", async () => {
		const courseRows = await db.execute(
			`SELECT id FROM courses ORDER BY id LIMIT 1`,
		);
		const courseId = (courseRows.rows[0] as { id: number }).id;
		const mod = await db.execute(
			`INSERT INTO modules (course_id, title, sort_order) VALUES (${courseId}, 'Drive Test Module', 999) RETURNING id`,
		);
		moduleId = (mod.rows[0] as { id: number }).id;

		const lesson = await service.createLesson(moduleId, {
			title: "Drive PDF",
			type: "google_drive",
			driveUrl: validLink,
		} as NewLesson);

		expect(lesson).toBeTruthy();
		expect((lesson as { driveUrl: string | null }).driveUrl).toBe(validLink);
		lessonIds.push((lesson as { id: number }).id);
	});

	it("allows creating a google_drive lesson without a link (draft, link added in the editor)", async () => {
		const draft = await service.createLesson(moduleId, {
			title: "Drive draft",
			type: "google_drive",
		} as NewLesson);
		expect(draft).toBeTruthy();
		expect((draft as { driveUrl: string | null }).driveUrl).toBeNull();
		lessonIds.push((draft as { id: number }).id);
	});

	it("rejects a google_drive lesson with a non-Google link", async () => {
		await expect(
			service.createLesson(moduleId, {
				title: "Bad link",
				type: "google_drive",
				driveUrl: "https://youtube.com/watch?v=x",
			} as NewLesson),
		).rejects.toThrow();
	});

	it("rejects an invalid link on update, allows clearing it", async () => {
		const [row] = await db
			.select()
			.from(lessons)
			.where(eq(lessons.id, lessonIds[0]!))
			.limit(1);
		expect(row?.type).toBe("google_drive");
		await expect(
			service.updateLesson(lessonIds[0]!, { driveUrl: "https://vimeo.com/123" }),
		).rejects.toThrow();
		const cleared = await service.updateLesson(lessonIds[0]!, { driveUrl: "" });
		expect((cleared as { driveUrl: string | null }).driveUrl).toBe("");
	});

	it("allows switching a google_drive lesson to another type", async () => {
		const updated = await service.updateLesson(lessonIds[0]!, {
			type: "text",
		} as any);
		expect((updated as { type: string }).type).toBe("text");
	});

	it("allows switching a lesson to google_drive without a link (draft state)", async () => {
		/* clear the link while the lesson is still a text lesson */
		await service.updateLesson(lessonIds[0]!, { driveUrl: "" });
		const updated = await service.updateLesson(lessonIds[0]!, {
			type: "google_drive",
		} as any);
		expect((updated as { type: string }).type).toBe("google_drive");
	});

	it("accepts an open?id= style link", async () => {
		const lesson = await service.createLesson(moduleId, {
			title: "Drive video",
			type: "google_drive",
			driveUrl: "https://drive.google.com/open?id=VIDEO777",
		} as NewLesson);
		expect(lesson).toBeTruthy();
		lessonIds.push((lesson as { id: number }).id);
	});

	/* cleanup */
	it("cleans up test rows", async () => {
		for (const id of lessonIds) {
			await db.execute(`DELETE FROM lessons WHERE id = ${id}`);
		}
		await db.execute(`DELETE FROM modules WHERE id = ${moduleId}`);
		expect(true).toBe(true);
	});
});
