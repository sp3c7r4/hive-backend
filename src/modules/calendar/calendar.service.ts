import { and, desc, eq, gte, lte, ne } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import { throwBadRequestError } from "@/helpers/errors/throw-errors";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { courses, lessons, modules } from "@/modules/courses/course.model";

/* @info - CalendarEvent shape the frontend consumes as-is (spec 19). */
export interface CalendarEvent {
	id: string;
	title: string;
	start: string;
	end: string;
	color: string;
	data: {
		courseId: number;
		courseSlug: string;
		courseTitle: string;
		moduleTitle: string;
		meetingType: "native" | "external";
		meetingUrl: string | null;
		liveStatus: string;
		description: string | null;
	};
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** @info - Colors by meeting kind: native = indigo, external = green */
const COLOR_BY_MEETING: Record<string, string> = {
	native: "#6366F1",
	external: "#059669",
};

/* @info - Cohort zone is Lagos (UTC+1, no DST). Month windows are computed
 * in that fixed offset; revisit if cohorts open outside west Africa.
 * ponytail: fixed UTC+1 assumption, per-cohort tz when multi-zone launches */
const LAGOS_OFFSET_MS = 60 * 60 * 1000;

function monthWindow(month: string): { start: Date; end: Date } {
	const [year, m] = month.split("-").map(Number);
	const startUtc = Date.UTC(year!, m! - 1, 1) - LAGOS_OFFSET_MS;
	const endUtc = Date.UTC(year!, m!, 1) - LAGOS_OFFSET_MS;
	return { start: new Date(startUtc), end: new Date(endUtc) };
}

export class CalendarService {
	private static instance: CalendarService;

	static getInstance(): CalendarService {
		if (!this.instance) this.instance = new CalendarService();
		return this.instance;
	}

	/** @info - GET /calendar/events?month=YYYY-MM
	 * Instructor-only: every non-ended live session (native + external)
	 * they own within the month, shaped for the calendar UI. */
	listEvents = async (authData: IAuthData, month: string) => {
		if (!MONTH_RE.test(month)) {
			throwBadRequestError("month must be YYYY-MM.");
		}
		const { start, end } = monthWindow(month);
		const db = getDb();

		const rows = await db
			.select({
				id: lessons.id,
				title: lessons.title,
				meetingType: lessons.meetingType,
				meetingUrl: lessons.meetingUrl,
				liveStatus: lessons.liveStatus,
				scheduledAt: lessons.scheduledAt,
				durationMinutes: lessons.durationMinutes,
				courseId: courses.id,
				courseSlug: courses.slug,
				courseTitle: courses.title,
				moduleTitle: modules.title,
				description: lessons.description,
			})
			.from(lessons)
			.innerJoin(modules, eq(lessons.moduleId, modules.id))
			.innerJoin(courses, eq(modules.courseId, courses.id))
			.where(
				and(
					eq(courses.instructorId, Number(authData.id)),
					ne(lessons.meetingType, "none"),
					ne(lessons.liveStatus, "ended"),
					gte(lessons.scheduledAt, start),
					lte(lessons.scheduledAt, end),
				),
			)
			.orderBy(desc(lessons.scheduledAt));

		return rows.map((row): CalendarEvent => {
			const startMs = row.scheduledAt!.getTime();
			return {
				id: `lesson-${row.id}`,
				title: row.title,
				start: new Date(startMs).toISOString(),
				end: new Date(
					startMs + (row.durationMinutes ?? 60) * 60_000,
				).toISOString(),
				color: COLOR_BY_MEETING[row.meetingType] ?? "#94A3B8",
				data: {
					courseId: row.courseId,
					courseSlug: row.courseSlug,
					courseTitle: row.courseTitle,
					moduleTitle: row.moduleTitle,
					meetingType: row.meetingType as "native" | "external",
					meetingUrl: row.meetingUrl,
					liveStatus: row.liveStatus,
					description: row.description,
				},
			};
		});
	};
}
