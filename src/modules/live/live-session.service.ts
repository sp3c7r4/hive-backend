import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import { LessonMeetingType } from "@/enums";
import {
	throwBadRequestError,
	throwForbiddenError,
	throwNotFoundError,
} from "@/helpers/errors/throw-errors";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { communityMembers } from "@/modules/communities/community.model";
import { courses, lessons, modules } from "@/modules/courses/course.model";
import { enrollments } from "@/modules/enrollments/enrollment.model";
import { type LiveSession, liveSessions } from "./live-session.model";

const SESSION_NOT_FOUND = "Session not found.";
const SESSION_ENDED = "This session has ended.";
const NO_HIVE_ROOM = "This session has no Hive room.";
const NOT_ENROLLED = "You are not enrolled in this course.";
const NOT_A_MEMBER = "You are not part of this community.";

/** @info - What the caller may do with a session (spec phase 1 section 5). */
export interface LiveSessionAccess {
	/** Host: the session's host_id or the course instructor. */
	isHost: boolean;
	/** May moderate (LiveKit roomAdmin) - hosts, and community owners/admins. */
	canModerate: boolean;
	/** Passes the access rule: host, enrolled student, or active member. */
	canJoin: boolean;
}

/** @info - Meeting fields a lesson save may carry (they live on the session now). */
export interface LessonMeetingInput {
	meetingType?: LessonMeetingType;
	meetingUrl?: string | null;
	scheduledAt?: Date | null;
	durationMinutes?: number;
}

const isFinished = (status: LiveSession["status"]): boolean =>
	status === "ended" || status === "cancelled";

export class LiveSessionService {
	private static instance: LiveSessionService;

	static getInstance(): LiveSessionService {
		if (!this.instance) this.instance = new LiveSessionService();
		return this.instance;
	}

	/* ── Loading ─────────────────────────────────────────────────────── */

	loadById = async (sessionId: number): Promise<LiveSession> => {
		const db = getDb();
		const [row] = await db
			.select()
			.from(liveSessions)
			.where(
				and(eq(liveSessions.id, sessionId), isNull(liveSessions.deletedAt)),
			)
			.limit(1);
		if (!row) throwNotFoundError(SESSION_NOT_FOUND);
		return row!;
	};

	/** @info - The lesson a session belongs to, or null for a standalone event. */
	loadLesson = async (
		sessionId: number,
	): Promise<{ id: number; title: string } | null> => {
		const db = getDb();
		const [row] = await db
			.select({ id: lessons.id, title: lessons.title })
			.from(lessons)
			.where(eq(lessons.liveSessionId, sessionId))
			.limit(1);
		return row! ?? null;
	};

	/* ── Access ──────────────────────────────────────────────────────── */

	private findActiveMembership = async (
		communityId: number,
		userId: number,
	): Promise<{ memberRole: string } | null> => {
		const db = getDb();
		const [row] = await db
			.select({ memberRole: communityMembers.memberRole })
			.from(communityMembers)
			.where(
				and(
					eq(communityMembers.communityId, communityId),
					eq(communityMembers.userId, userId),
					eq(communityMembers.status, "active"),
				),
			)
			.limit(1);
		return row! ?? null;
	};

	private hasActiveEnrollment = async (
		userId: number,
		courseId: number,
	): Promise<boolean> => {
		const db = getDb();
		const [row] = await db
			.select({ id: enrollments.id })
			.from(enrollments)
			.where(
				and(
					eq(enrollments.userId, userId),
					eq(enrollments.courseId, courseId),
					isNull(enrollments.deletedAt),
				),
			)
			.limit(1);
		return Boolean(row);
	};

	private loadCourseInstructor = async (
		courseId: number,
	): Promise<number | null> => {
		const db = getDb();
		const [row] = await db
			.select({ instructorId: courses.instructorId })
			.from(courses)
			.where(eq(courses.id, courseId))
			.limit(1);
		return row?.instructorId ?? null;
	};

	/**
	 * @info - Decision A (no widening): a lesson session is for the course's
	 * instructor and its enrolled students only - community membership does NOT
	 * open a paid course's live class, because a course payment and a community
	 * payment are different products. Standalone sessions (no course) are gated by
	 * active community membership instead.
	 */
	resolveAccess = async (
		session: LiveSession,
		authData?: IAuthData,
	): Promise<LiveSessionAccess> => {
		const userId = Number(authData?.id);
		if (!userId) return { isHost: false, canModerate: false, canJoin: false };

		if (session.courseId === null) {
			const membership = await this.findActiveMembership(
				session.communityId,
				userId,
			);
			const isOwnerOrAdmin =
				membership?.memberRole === "owner" ||
				membership?.memberRole === "admin";
			const isHost = session.hostId === userId;
			return {
				isHost,
				canModerate: isHost || isOwnerOrAdmin,
				canJoin: isHost || isOwnerOrAdmin || Boolean(membership),
			};
		}

		const instructorId = await this.loadCourseInstructor(session.courseId);
		const isCourseInstructor = instructorId === userId;
		const isHost = session.hostId === userId || isCourseInstructor;
		const enrolled =
			isHost || (await this.hasActiveEnrollment(userId, session.courseId));
		return { isHost, canModerate: isHost, canJoin: enrolled };
	};

	private assertCanAccess = async (
		session: LiveSession,
		authData?: IAuthData,
	): Promise<LiveSessionAccess> => {
		const access = await this.resolveAccess(session, authData);
		if (!access.canJoin) {
			throwForbiddenError(
				session.courseId === null ? NOT_A_MEMBER : NOT_ENROLLED,
			);
		}
		return access;
	};

	/* ── Gates used by the live endpoints ────────────────────────────── */

	/** @info - GET /live/sessions/:id - access gate only; a finished session still renders. */
	getSessionView = async (authData: IAuthData, sessionId: number) => {
		const session = await this.loadById(sessionId);
		const access = await this.assertCanAccess(session, authData);
		const lesson = await this.loadLesson(session.id);
		return {
			id: session.id,
			kind: session.kind,
			title: session.title,
			description: session.description,
			status: session.status,
			startsAt: session.startsAt,
			durationMinutes: session.durationMinutes,
			meetingUrl: session.meetingUrl,
			communityId: session.communityId,
			courseId: session.courseId,
			hostId: session.hostId,
			isHost: access.isHost,
			canJoin: access.canJoin && (!isFinished(session.status) || access.isHost),
			lesson,
		};
	};

	/** @info - Join gate: access, then kind (only native sessions have a room), then status. */
	loadForJoin = async (authData: IAuthData, sessionId: number) => {
		const session = await this.loadById(sessionId);
		const access = await this.assertCanAccess(session, authData);
		if (session.kind !== "native") throwBadRequestError(NO_HIVE_ROOM);
		if (isFinished(session.status) && !access.isHost) {
			throwBadRequestError(SESSION_ENDED);
		}
		return { session, access };
	};

	/** @info - go-live / end-live are the host's to call, and native only. */
	loadForHostAction = async (authData: IAuthData, sessionId: number) => {
		const session = await this.loadById(sessionId);
		const access = await this.resolveAccess(session, authData);
		if (!access.isHost) {
			throwForbiddenError("Only the host can change this session.");
		}
		if (session.kind !== "native") throwBadRequestError(NO_HIVE_ROOM);
		return { session, access };
	};

	/** @info - Move to live, stamping the first start time once (idempotent). */
	markLive = async (sessionId: number): Promise<LiveSession> => {
		const db = getDb();
		const [row] = await db
			.update(liveSessions)
			.set({
				status: "live",
				startsAt: sql`COALESCE(${liveSessions.startsAt}, now())`,
			})
			.where(
				and(eq(liveSessions.id, sessionId), isNull(liveSessions.deletedAt)),
			)
			.returning();
		if (!row) throwNotFoundError(SESSION_NOT_FOUND);
		return row!;
	};

	/** @info - Move to ended (idempotent). */
	markEnded = async (sessionId: number): Promise<LiveSession> => {
		const db = getDb();
		const [row] = await db
			.update(liveSessions)
			.set({ status: "ended" })
			.where(
				and(eq(liveSessions.id, sessionId), isNull(liveSessions.deletedAt)),
			)
			.returning();
		if (!row) throwNotFoundError(SESSION_NOT_FOUND);
		return row!;
	};

	/* ── Lesson-driven session lifecycle ─────────────────────────────── */

	/**
	 * @info - Soft-delete a session and mark it cancelled, so it leaves the calendar and
	 * stops being joinable. Used when the lesson that owned it is saved as a
	 * non-meeting, or deleted outright: the lesson row goes away, but the session row
	 * would otherwise keep rendering and stay reachable at /live/s/<id>.
	 */
	discardSession = async (sessionId: number): Promise<void> => {
		const db = getDb();
		await db
			.update(liveSessions)
			.set({ status: "cancelled", deletedAt: new Date() })
			.where(
				and(eq(liveSessions.id, sessionId), isNull(liveSessions.deletedAt)),
			);
	};

	/**
	 * @info - Called from every lesson save path. Creates the lesson's session on
	 * first save with a meeting, keeps its id stable on later saves (links, rooms and
	 * recordings hang off that id), and detaches + soft-deletes it when the lesson is
	 * saved as a non-meeting.
	 */
	syncLessonMeeting = async (
		lessonId: number,
		meeting: LessonMeetingInput,
	): Promise<LiveSession | null> => {
		const db = getDb();
		const [lesson] = await db
			.select({
				id: lessons.id,
				title: lessons.title,
				description: lessons.description,
				liveSessionId: lessons.liveSessionId,
				courseId: modules.courseId,
			})
			.from(lessons)
			.innerJoin(modules, eq(modules.id, lessons.moduleId))
			.where(eq(lessons.id, lessonId))
			.limit(1);
		if (!lesson) throwNotFoundError("Lesson not found.");
		const target = lesson!;

		const requestedKind = meeting.meetingType;
		/* @info - Only an explicit 'none' clears the meeting. An absent meetingType means
		 * this save did not touch the meeting (a title edit), so the session must be left
		 * alone - treating absent as 'clear' would detach it on every unrelated edit. */
		if (requestedKind === LessonMeetingType.NONE) {
			if (target.liveSessionId) {
				await db
					.update(lessons)
					.set({ liveSessionId: null })
					.where(eq(lessons.id, lessonId));
				await this.discardSession(target.liveSessionId);
			}
			return null;
		}

		const existing = target.liveSessionId
			? await this.loadById(target.liveSessionId)
			: null;

		/* @info - A save with neither a kind nor a url and no session yet is not a
		 * meeting at all (plain video/pdf/quiz lessons land here on every save). */
		if (!existing && !requestedKind && !meeting.meetingUrl) return null;

		/* @info - The kind is fixed once the session exists: links, rooms and recordings
		 * hang off that id, so turning a Hive room into an external meeting (or back)
		 * would silently repoint them. The instructor removes the live class and adds it
		 * again instead. */
		const existingKind = existing?.kind as LessonMeetingType | undefined;
		if (existingKind && requestedKind && requestedKind !== existingKind) {
			throwBadRequestError(
				"A live class type cannot be changed after it is created. Set the type to None and save, then choose the new type.",
			);
		}
		const kind = existingKind ?? requestedKind ?? LessonMeetingType.EXTERNAL;
		const external = kind === LessonMeetingType.EXTERNAL;
		const duration = meeting.durationMinutes ?? existing?.durationMinutes ?? 60;
		/* @info - Rescheduling an ended session re-arms it: ended sessions are hidden
		 * from the calendar, which made reschedules look like they never committed. */
		const status =
			meeting.scheduledAt && existing?.status === "ended"
				? ("scheduled" as const)
				: undefined;

		if (existing) {
			const [updated] = await db
				.update(liveSessions)
				.set({
					kind,
					title: target.title,
					description: target.description,
					/* @info - A save that omits the url keeps the stored one: most lesson
					 * edits never touch it, and dropping a pasted link on an unrelated save is
					 * silent data loss. An explicit null still clears it. */
					meetingUrl: external
						? meeting.meetingUrl !== undefined
							? meeting.meetingUrl
							: existing.meetingUrl
						: (existing.meetingUrl ?? null),
					startsAt: meeting.scheduledAt,
					durationMinutes: duration,
					status,
				})
				.where(eq(liveSessions.id, existing.id))
				.returning();
			return updated ?? existing;
		}

		const [course] = await db
			.select({
				id: courses.id,
				communityId: courses.communityId,
				instructorId: courses.instructorId,
			})
			.from(courses)
			.where(eq(courses.id, target.courseId))
			.limit(1);
		if (!course) throwNotFoundError("Course not found.");
		const scope = course!;

		const [created] = await db
			.insert(liveSessions)
			.values({
				kind,
				communityId: scope.communityId,
				courseId: scope.id,
				hostId: scope.instructorId,
				title: target.title,
				description: target.description,
				meetingUrl: external ? (meeting.meetingUrl ?? null) : null,
				startsAt: meeting.scheduledAt ?? null,
				durationMinutes: duration,
			})
			.returning();
		if (!created) throwNotFoundError(SESSION_NOT_FOUND);
		const session = created!;
		await db
			.update(lessons)
			.set({ liveSessionId: session.id })
			.where(eq(lessons.id, lessonId));
		return session;
	};
}
