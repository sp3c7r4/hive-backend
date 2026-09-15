import { and, desc, eq, gte, isNull, lte, ne } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import { throwBadRequestError } from "@/helpers/errors/throw-errors";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { courses, lessons, modules } from "@/modules/courses/course.model";
import { liveSessions } from "@/modules/live/live-session.model";

/* @info - CalendarEvent shape the frontend consumes as-is. Sessions are the single
 * source for both kinds: a native lesson's room and an external meeting link.
 * `lessonId` is null for a session that is not a lesson (standalone events). */
export interface CalendarEvent {
	id: string;
	title: string;
	start: string;
	end: string;
	color: string;
	data: {
		sessionId: number;
		lessonId: number | null;
		courseId: number | null;
		courseSlug: string | null;
		courseTitle: string | null;
		moduleTitle: string | null;
		meetingType: "native" | "external";
		meetingUrl: string | null;
		liveStatus: string;
		description: string | null;
	};
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** @info - Colors by session kind: native = indigo, external = green */
const COLOR_BY_KIND: Record<string, string> = {
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
	 * Instructor-only: every live session (native + external) they host within the
	 * month, shaped for the calendar UI. */
	listEvents = async (authData: IAuthData, month: string) => {
		if (!MONTH_RE.test(month)) {
			throwBadRequestError("month must be YYYY-MM.");
		}
		const { start, end } = monthWindow(month);
		const db = getDb();

		const rows = await db
			.select({
				id: liveSessions.id,
				kind: liveSessions.kind,
				title: liveSessions.title,
				meetingUrl: liveSessions.meetingUrl,
				status: liveSessions.status,
				startsAt: liveSessions.startsAt,
				durationMinutes: liveSessions.durationMinutes,
				description: liveSessions.description,
				lessonId: lessons.id,
				moduleTitle: modules.title,
				courseId: courses.id,
				courseSlug: courses.slug,
				courseTitle: courses.title,
			})
			.from(liveSessions)
			.leftJoin(courses, eq(courses.id, liveSessions.courseId))
			.leftJoin(lessons, eq(lessons.liveSessionId, liveSessions.id))
			.leftJoin(modules, eq(modules.id, lessons.moduleId))
			.where(
				and(
					eq(liveSessions.hostId, Number(authData.id)),
					isNull(liveSessions.deletedAt),
					ne(liveSessions.status, "ended"),
					ne(liveSessions.status, "cancelled"),
					gte(liveSessions.startsAt, start),
					lte(liveSessions.startsAt, end),
				),
			)
			.orderBy(desc(liveSessions.startsAt));

		return rows.map((row): CalendarEvent => {
			const startMs = row.startsAt!.getTime();
			return {
				id: `session-${row.id}`,
				title: row.title,
				start: new Date(startMs).toISOString(),
				end: new Date(
					startMs + (row.durationMinutes ?? 60) * 60_000,
				).toISOString(),
				color: COLOR_BY_KIND[row.kind] ?? "#94A3B8",
				data: {
					sessionId: row.id,
					lessonId: row.lessonId,
					courseId: row.courseId,
					courseSlug: row.courseSlug,
					courseTitle: row.courseTitle,
					moduleTitle: row.moduleTitle,
					meetingType: row.kind as "native" | "external",
					meetingUrl: row.meetingUrl,
					liveStatus: row.status,
					description: row.description,
				},
			};
		});
	};
}
