import { inArray } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import { LessonMeetingType } from "@/enums";
import { liveSessions, type LiveSession } from "./live-session.model";

/**
 * @info - Lesson payloads keep the field names the frontend already consumes
 * (meetingType / meetingUrl / scheduledAt / durationMinutes / liveStatus) but the
 * values now come from the lesson's live session. Migration 0028 dropped the
 * matching lessons columns, so this mapper is the only place those fields are
 * produced - there is no column to go looking for.
 */
export interface LiveSessionFields {
	liveSessionId: number | null;
	meetingType: LessonMeetingType;
	meetingUrl: string | null;
	scheduledAt: Date | null;
	durationMinutes: number;
	liveStatus: LiveSession["status"];
}

const DEFAULT_DURATION_MINUTES = 60;

/** @info - A lesson with no session is not a meeting: 'none', 60 minutes, no url. */
export const toLiveSessionFields = (
	session?: LiveSession | null,
): LiveSessionFields => ({
	liveSessionId: session?.id ?? null,
	meetingType: session
		? (session.kind as LessonMeetingType)
		: LessonMeetingType.NONE,
	meetingUrl: session?.meetingUrl ?? null,
	scheduledAt: session?.startsAt ?? null,
	durationMinutes: session?.durationMinutes ?? DEFAULT_DURATION_MINUTES,
	liveStatus: session?.status ?? "scheduled",
});

/**
 * @info - Attach the session-sourced fields to lesson rows. One extra query for the
 * whole batch, so list endpoints stay two queries rather than N+1.
 */
export const decorateLessonsWithSessions = async <
	T extends { liveSessionId?: number | null },
>(
	rows: T[],
): Promise<(T & LiveSessionFields)[]> => {
	const sessionIds = rows
		.map((row) => row.liveSessionId)
		.filter((id): id is number => typeof id === "number");
	if (sessionIds.length === 0) {
		return rows.map((row) => ({ ...row, ...toLiveSessionFields(null) }));
	}

	const db = getDb();
	const sessions = await db
		.select()
		.from(liveSessions)
		.where(inArray(liveSessions.id, sessionIds));
	const byId = new Map(sessions.map((session) => [session.id, session]));

	return rows.map((row) => ({
		...row,
		...toLiveSessionFields(
			row.liveSessionId ? (byId.get(row.liveSessionId) ?? null) : null,
		),
	}));
};
