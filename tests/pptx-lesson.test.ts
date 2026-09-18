import { beforeAll, describe, expect, it } from "vitest";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import {
	LessonType,
} from "@/enums";
import type { NewLesson } from "@/modules/courses/course.model";
import { CourseService } from "@/modules/courses/course.service";

/**
 * @info - Service-level validation for the pptx lesson type (§10.5 of the spec).
 * Mirrors tests/google-drive-lesson.test.ts: real rows in a throwaway module,
 * cleaned up afterwards.
 *
 * @info - Requires a live test Postgres (`docker compose -f docker-compose.dev.yml
 * up -d`) with `npm run migrate` applied, the same as every other test here.
 */
describe("CourseService pptx lesson persistence", () => {
	const service = CourseService.getInstance();
	const ADMIN_AUTH = {
		authId: "auth:pptx-test-admin",
		id: 1,
		roles: ["admin"],
	} as unknown as IAuthData;
	let db: ReturnType<typeof getDb>;

	const DECK_URL = "https://cdn.tryhive.app/pptx/test-deck-123.pptx";

	beforeAll(async () => {
		await connectPostgresDB(() => {});
		db = getDb();
	});

	let courseId: number;
	let moduleId: number;
	const lessonIds: number[] = [];

	it("creates a pptx lesson with a deck url", async () => {
		const courseRows = await db.execute(`SELECT id FROM courses ORDER BY id LIMIT 1`);
		courseId = (courseRows.rows[0] as { id: number }).id;
		const mod = await db.execute(
			`INSERT INTO modules (course_id, title, sort_order) VALUES (${courseId}, 'Pptx Test Module', 999) RETURNING id`,
		);
		moduleId = (mod.rows[0] as { id: number }).id;

		const lesson = await service.createLesson(ADMIN_AUTH, moduleId, {
			title: "Intro Deck",
			type: LessonType.PPTX,
			pptxUrl: DECK_URL,
		} as NewLesson);

		expect(lesson).toBeTruthy();
		expect((lesson as { pptxUrl: string | null }).pptxUrl).toBe(DECK_URL);
		expect((lesson as { type: string }).type).toBe("pptx");
		lessonIds.push((lesson as { id: number }).id);
	});

	it("allows creating a pptx lesson without a deck (draft, file added in the editor)", async () => {
		const draft = await service.createLesson(ADMIN_AUTH, moduleId, {
			title: "Deck draft",
			type: LessonType.PPTX,
		} as NewLesson);
		expect(draft).toBeTruthy();
		expect((draft as { pptxUrl: string | null }).pptxUrl).toBeNull();
		lessonIds.push((draft as { id: number }).id);
	});

	it("persists a deck url on an existing lesson", async () => {
		const draft = await service.createLesson(ADMIN_AUTH, moduleId, {
			title: "Deck to fill in",
			type: LessonType.PPTX,
		} as NewLesson);
		const id = (draft as { id: number }).id;
		lessonIds.push(id);

		await service.updateLesson(ADMIN_AUTH, id, {
			pptxUrl: DECK_URL,
		} as Partial<NewLesson>);

		const rows = await db.execute(
			`SELECT pptx_url FROM lessons WHERE id = ${id}`,
		);
		expect((rows.rows[0] as { pptx_url: string }).pptx_url).toBe(DECK_URL);
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
