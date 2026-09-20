import {
	index,
	integer,
	pgEnum,
	pgTable,
	text,
	timestamp,
	varchar,
} from "drizzle-orm/pg-core";
import {
	LiveSessionKind,
	LiveSessionStatus,
	RecordingStatus,
	TableNames,
} from "@/enums";
import { softDelete } from "@/models/soft-delete.model";
import { timestamps } from "@/models/timestamps.b.model";

export const liveSessionKindEnum = pgEnum(
	"live_session_kind",
	Object.values(LiveSessionKind) as [string, ...string[]],
);
export const liveSessionStatusEnum = pgEnum(
	"live_session_status",
	Object.values(LiveSessionStatus) as [string, ...string[]],
);
export const liveRecordingStatusEnum = pgEnum(
	"live_recording_status",
	Object.values(RecordingStatus) as [string, ...string[]],
);

/**
 * @info - One row per scheduled live thing: a live lesson's room, or a standalone
 * community event (no lesson). The session is the unit every subsystem keys on -
 * join token, room name, moderation, recording, links - and a lesson points at it
 * through `lessons.live_session_id`.
 *
 * The foreign keys are plain integers on purpose: `.references()` would import the
 * course and community models, which import this file for `lessons.live_session_id`,
 * and `npm run check:circular` must stay clean. The constraints live in migration
 * 0028 next to the copy of this shape.
 *
 * The room name is NOT stored: it is derived as `{LIVEKIT_ROOM_PREFIX}session-{id}`
 * so a deploy cannot strand an in-flight room by recomputing a different name - the
 * id is immutable.
 */
export const liveSessions = pgTable(
	TableNames.LIVE_SESSIONS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		kind: liveSessionKindEnum("kind").notNull(),
		communityId: integer("community_id").notNull(),
		courseId: integer("course_id"),
		hostId: integer("host_id").notNull(),
		title: varchar("title", { length: 255 }).notNull(),
		description: text("description"),
		meetingUrl: varchar("meeting_url", { length: 1000 }),
		startsAt: timestamp("starts_at", { withTimezone: true }),
		durationMinutes: integer("duration_minutes").default(60).notNull(),
		status: liveSessionStatusEnum("status").default("scheduled").notNull(),
		/* @info - Recording (phase 5a). All nullable: a session that was never recorded
		 * carries null everywhere, and the migration can land before the code. The key is
		 * derived from the immutable id like the room name, so no deploy can strand a file
		 * by recomputing a different one. */
		recordingStatus: liveRecordingStatusEnum("recording_status"),
		recordingEgressId: varchar("recording_egress_id", { length: 255 }),
		recordingKey: varchar("recording_key", { length: 1000 }),
		recordingDurationSeconds: integer("recording_duration_seconds"),
		recordingStartedAt: timestamp("recording_started_at", {
			withTimezone: true,
		}),
		recordingEndedAt: timestamp("recording_ended_at", {
			withTimezone: true,
		}),
		recordingError: text("recording_error"),
		...timestamps,
		...softDelete,
	},
	(table) => [
		index("idx_live_sessions_community_starts").on(
			table.communityId,
			table.startsAt,
		),
		index("idx_live_sessions_host_starts").on(table.hostId, table.startsAt),
		index("idx_live_sessions_course").on(table.courseId),
	],
);

export type LiveSession = typeof liveSessions.$inferSelect;
export type NewLiveSession = typeof liveSessions.$inferInsert;
