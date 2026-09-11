import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import { LessonMeetingType, NotificationType } from "@/enums";
import {
	throwBadRequestError,
	throwForbiddenError,
	throwNotFoundError,
} from "@/helpers/errors/throw-errors";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import {
	communities,
	communityMembers,
} from "@/modules/communities/community.model";
import { courses, lessons, modules } from "@/modules/courses/course.model";
import { enrollments } from "@/modules/enrollments/enrollment.model";
import { NotificationService } from "@/modules/notifications";
import { serviceLogger } from "@/utils";
import {
	type LiveSession,
	liveSessions,
	type NewLiveSession,
} from "./live-session.model";

const SESSION_NOT_FOUND = "Session not found.";
const SESSION_ENDED = "This session has ended.";
const NO_HIVE_ROOM = "This session has no Hive room.";
const NOT_ENROLLED = "You are not enrolled in this course.";
const NOT_A_MEMBER = "You are not part of this community.";
/* @info - Standalone events (phase 2). An outsider is told the community does not
exist rather than that they may not touch it (decision D-P2-6: no anonymous tier
applies to discovery either). */
const COMMUNITY_NOT_FOUND = "Community not found.";
const NOT_OWNER_OR_ADMIN =
	"Only community owners and admins can schedule a live class.";
const ONLY_HOST =
	"Only the host or a community owner/admin can change this session.";
const NEEDS_LINK = "An external session needs a meeting link.";
const NO_LINK_ON_HIVE_ROOM = "A Hive room session has no meeting link.";
const LESSON_OWNED_FIELDS =
	"This session belongs to a lesson - edit its title or description from the course.";
const BAD_SCOPE = "scope must be upcoming or past.";
const MIN_DURATION_MINUTES = 5;
const DEFAULT_DURATION_MINUTES = 60;

/** @info - "15 Sep 2026, 14:00" in the cohort's fixed zone, matching the calendar. */
const formatStartsAt = (date: Date): string =>
	new Intl.DateTimeFormat("en-NG", {
		dateStyle: "medium",
		timeStyle: "short",
		timeZone: "Africa/Lagos",
	}).format(date);

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

/** @info - What a community owner/admin sends when scheduling a standalone event. */
export interface CreateLiveSessionInput {
	kind: LiveSession["kind"];
	title: string;
	description?: string | null;
	startsAt?: string | Date | null;
	durationMinutes?: number;
	meetingUrl?: string | null;
}

/** @info - Editable fields of an existing session. `kind` is accepted only so a
 *  mismatch can be refused with the phase 1 message rather than ignored. */
export interface UpdateLiveSessionInput {
	kind?: LiveSession["kind"];
	title?: string;
	description?: string | null;
	startsAt?: string | Date | null;
	durationMinutes?: number;
	meetingUrl?: string | null;
}

export type CommunitySessionScope = "upcoming" | "past";

/** @info - The session payload the API returns (room page, community live list). */
export interface LiveSessionView {
	id: number;
	kind: LiveSession["kind"];
	title: string;
	description: string | null;
	status: LiveSession["status"];
	startsAt: Date | null;
	durationMinutes: number;
	meetingUrl: string | null;
	communityId: number;
	communitySlug: string | null;
	courseId: number | null;
	hostId: number;
	isHost: boolean;
	canModerate: boolean;
	canJoin: boolean;
	lesson: { id: number; title: string } | null;
}

const isFinished = (status: LiveSession["status"]): boolean =>
	status === "ended" || status === "cancelled";

export class LiveSessionService {
	private static instance: LiveSessionService;
	private readonly log = serviceLogger("LiveSessions");

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

	/** @info - Lessons for a batch of sessions, keyed by session id: a standalone event
	 *  has none, so a list stays two queries instead of one per row. */
	private lessonsForSessions = async (
		sessionIds: number[],
	): Promise<Map<number, { id: number; title: string }>> => {
		if (sessionIds.length === 0) return new Map();
		const db = getDb();
		const rows = await db
			.select({
				id: lessons.id,
				title: lessons.title,
				liveSessionId: lessons.liveSessionId,
			})
			.from(lessons)
			.where(inArray(lessons.liveSessionId, sessionIds));
		return new Map(
			rows
				.filter((row) => row.liveSessionId !== null)
				.map((row) => [
					row.liveSessionId as number,
					{ id: row.id, title: row.title },
				]),
		);
	};

	/** @info - The lesson a session belongs to, or null for a standalone event. */
	loadLesson = async (
		sessionId: number,
	): Promise<{ id: number; title: string } | null> => {
		const lessonsBySession = await this.lessonsForSessions([sessionId]);
		return lessonsBySession.get(sessionId) ?? null;
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
	getSessionView = async (
		authData: IAuthData,
		sessionId: number,
	): Promise<LiveSessionView> => {
		const session = await this.loadById(sessionId);
		const access = await this.assertCanAccess(session, authData);
		const lesson = await this.loadLesson(session.id);
		const community = await this.findCommunity(session.communityId);
		return this.toSessionView(session, access, lesson, community?.slug ?? null);
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

	/* ── Standalone community events (phase 2) ───────────────────────── */

	/** @info - Community by id, or null when it is missing or soft-deleted. */
	private findCommunity = async (
		communityId: number,
	): Promise<{ id: number; name: string; slug: string } | null> => {
		const db = getDb();
		const [row] = await db
			.select({
				id: communities.id,
				name: communities.name,
				slug: communities.slug,
			})
			.from(communities)
			.where(
				and(eq(communities.id, communityId), isNull(communities.deletedAt)),
			)
			.limit(1);
		return row! ?? null;
	};

	/**
	 * @info - Active membership, or 404. The 404 (rather than 403) is deliberate for a
	 * non-member: the API must not confirm that a community they have no relationship
	 * with exists. Members get 403 later, when they lack the role for the action.
	 */
	private assertActiveMember = async (
		communityId: number,
		userId: number,
	): Promise<{
		community: { id: number; name: string; slug: string };
		isOwnerOrAdmin: boolean;
	}> => {
		const community = await this.findCommunity(communityId);
		const membership = community
			? await this.findActiveMembership(communityId, userId)
			: null;
		if (!community || !membership) throwNotFoundError(COMMUNITY_NOT_FOUND);
		return {
			community: community!,
			isOwnerOrAdmin:
				membership!.memberRole === "owner" ||
				membership!.memberRole === "admin",
		};
	};

	/** @info - Scheduling is owner/admin only; an ordinary member cannot create one. */
	private assertCommunityOwnerOrAdmin = async (
		communityId: number,
		userId: number,
	) => {
		const { community, isOwnerOrAdmin } = await this.assertActiveMember(
			communityId,
			userId,
		);
		if (!isOwnerOrAdmin) throwForbiddenError(NOT_OWNER_OR_ADMIN);
		return community;
	};

	/**
	 * @info - Who may change a session: its host, or a community owner/admin for a
	 * standalone event. A lesson session stays host-only (a community owns no part of a
	 * paid course's class, so its admins are not moderators of it).
	 */
	private assertCanModerate = async (
		session: LiveSession,
		authData: IAuthData,
	): Promise<LiveSessionAccess> => {
		const access = await this.resolveAccess(session, authData);
		if (!access.canModerate) throwForbiddenError(ONLY_HOST);
		return access;
	};

	/** @info - Shared session payload. `communitySlug` is what lets the room send
	 *  participants back to their community instead of the courses dashboard. */
	private toSessionView = (
		session: LiveSession,
		access: LiveSessionAccess,
		lesson: { id: number; title: string } | null,
		communitySlug: string | null,
	): LiveSessionView => ({
		id: session.id,
		kind: session.kind,
		title: session.title,
		description: session.description,
		status: session.status,
		startsAt: session.startsAt,
		durationMinutes: session.durationMinutes,
		meetingUrl: session.meetingUrl,
		communityId: session.communityId,
		communitySlug,
		courseId: session.courseId,
		hostId: session.hostId,
		isHost: access.isHost,
		canModerate: access.canModerate,
		canJoin: access.canJoin && (!isFinished(session.status) || access.isHost),
		lesson,
	});

	/**
	 * @info - Kind and link are kept consistent: an external session must carry a link,
	 * a Hive room must not. `undefined` means "this save did not touch the link" and
	 * keeps the stored one; an explicit null on an external session is refused rather
	 * than leaving it pointing nowhere.
	 */
	private resolveMeetingUrl = (
		kind: LiveSession["kind"],
		meetingUrl: string | null | undefined,
		stored: string | null,
	): string | null => {
		const url =
			meetingUrl === undefined ? stored : (meetingUrl ?? "").trim() || null;
		if (kind === "external" && !url) throwBadRequestError(NEEDS_LINK);
		if (kind === "native" && url) throwBadRequestError(NO_LINK_ON_HIVE_ROOM);
		return url;
	};

	private normalizeStartsAt = (
		value: string | Date | null | undefined,
	): Date | null => {
		if (value === null || value === undefined) return null;
		const date = value instanceof Date ? value : new Date(value);
		if (Number.isNaN(date.getTime())) {
			throwBadRequestError("startsAt must be a valid date.");
		}
		return date;
	};

	private normalizeDuration = (
		value: number | undefined,
		fallback: number,
	): number => {
		if (value === undefined) return fallback;
		if (!Number.isFinite(value) || value < MIN_DURATION_MINUTES) {
			throwBadRequestError(
				`A live class lasts at least ${MIN_DURATION_MINUTES} minutes.`,
			);
		}
		return Math.floor(value);
	};

	/** @info - POST /live/communities/:communityId/sessions - the creator becomes the host. */
	createSession = async (
		authData: IAuthData,
		communityId: number,
		input: CreateLiveSessionInput,
	): Promise<LiveSessionView> => {
		const userId = Number(authData?.id);
		const community = await this.assertCommunityOwnerOrAdmin(
			communityId,
			userId,
		);
		if (input.kind !== "native" && input.kind !== "external") {
			throwBadRequestError("kind must be native or external.");
		}
		const title = (input.title ?? "").trim();
		if (!title) throwBadRequestError("A live class needs a title.");

		const db = getDb();
		const [created] = await db
			.insert(liveSessions)
			.values({
				kind: input.kind,
				communityId: community.id,
				courseId: null,
				hostId: userId,
				title,
				description: input.description ?? null,
				meetingUrl: this.resolveMeetingUrl(input.kind, input.meetingUrl, null),
				startsAt: this.normalizeStartsAt(input.startsAt),
				durationMinutes: this.normalizeDuration(
					input.durationMinutes,
					DEFAULT_DURATION_MINUTES,
				),
				status: "scheduled",
			})
			.returning();
		if (!created) throwNotFoundError(SESSION_NOT_FOUND);
		const session = created!;

		/* @info - Fire-and-forget: telling N members must not delay the response, and
		 * notify() logs its own failures instead of throwing. */
		void this.notifyMembers(community, session);

		return this.toSessionView(
			session,
			{ isHost: true, canModerate: true, canJoin: true },
			null,
			community.slug,
		);
	};

	/** @info - PATCH /live/sessions/:sessionId - host or community owner/admin. */
	updateSession = async (
		authData: IAuthData,
		sessionId: number,
		input: UpdateLiveSessionInput,
	): Promise<LiveSessionView> => {
		const session = await this.loadById(sessionId);
		const access = await this.assertCanModerate(session, authData);

		if (input.kind && input.kind !== session.kind) {
			throwBadRequestError(
				"A live class type cannot be changed after it is created. Set the type to None and save, then choose the new type.",
			);
		}
		/* @info - A lesson session takes its title and description from the lesson, so
		 * accepting them here would be silently overwritten by the next lesson save. Time,
		 * duration and the link are shared with the lesson saver and stay editable. */
		if (
			session.courseId !== null &&
			(input.title !== undefined || input.description !== undefined)
		) {
			throwBadRequestError(LESSON_OWNED_FIELDS);
		}

		const set: Partial<NewLiveSession> = {};
		if (input.title !== undefined) {
			const title = input.title.trim();
			if (!title) throwBadRequestError("A live class needs a title.");
			set.title = title;
		}
		if (input.description !== undefined) set.description = input.description;
		if (input.durationMinutes !== undefined) {
			set.durationMinutes = this.normalizeDuration(
				input.durationMinutes,
				session.durationMinutes,
			);
		}
		if (input.meetingUrl !== undefined) {
			set.meetingUrl = this.resolveMeetingUrl(
				session.kind,
				input.meetingUrl,
				session.meetingUrl,
			);
		}
		if (input.startsAt !== undefined) {
			const startsAt = this.normalizeStartsAt(input.startsAt);
			set.startsAt = startsAt;
			/* @info - Rescheduling re-arms an ended session, exactly as a lesson save does:
			 * otherwise the reschedule looks like it never committed. */
			if (startsAt && session.status === "ended") set.status = "scheduled";
		}

		const lesson = await this.loadLesson(session.id);
		const community = await this.findCommunity(session.communityId);
		const communitySlug = community?.slug ?? null;

		/* @info - Nothing to change: return the current view instead of sending Postgres an
		 * empty SET, which it rejects ("No values to set"). */
		if (Object.keys(set).length === 0) {
			return this.toSessionView(session, access, lesson, communitySlug);
		}

		const db = getDb();
		const [updated] = await db
			.update(liveSessions)
			.set(set)
			.where(
				and(eq(liveSessions.id, session.id), isNull(liveSessions.deletedAt)),
			)
			.returning();
		if (!updated) throwNotFoundError(SESSION_NOT_FOUND);
		return this.toSessionView(updated!, access, lesson, communitySlug);
	};

	/** @info - POST /live/sessions/:sessionId/cancel - keeps the record, blocks joining. */
	cancelSession = async (
		authData: IAuthData,
		sessionId: number,
	): Promise<LiveSessionView> => {
		const session = await this.loadById(sessionId);
		const access = await this.assertCanModerate(session, authData);
		const lesson = await this.loadLesson(session.id);
		const community = await this.findCommunity(session.communityId);
		const communitySlug = community?.slug ?? null;

		/* idempotent: cancelling twice is the same as cancelling once */
		if (session.status === "cancelled") {
			return this.toSessionView(session, access, lesson, communitySlug);
		}

		const db = getDb();
		const [updated] = await db
			.update(liveSessions)
			.set({ status: "cancelled" })
			.where(
				and(eq(liveSessions.id, session.id), isNull(liveSessions.deletedAt)),
			)
			.returning();
		if (!updated) throwNotFoundError(SESSION_NOT_FOUND);
		return this.toSessionView(updated!, access, lesson, communitySlug);
	};

	/** @info - DELETE /live/sessions/:sessionId - soft delete, for a mistake. */
	deleteSession = async (
		authData: IAuthData,
		sessionId: number,
	): Promise<{ sessionId: number; deleted: true }> => {
		const session = await this.loadById(sessionId);
		await this.assertCanModerate(session, authData);

		const db = getDb();
		const [row] = await db
			.update(liveSessions)
			/* @info - Deleting a live session ends it too: the row leaves every query, so a
			 * room still running would have no way to report itself as finished. */
			.set({
				deletedAt: new Date(),
				status: session.status === "live" ? "ended" : session.status,
			})
			.where(
				and(eq(liveSessions.id, session.id), isNull(liveSessions.deletedAt)),
			)
			.returning();
		if (!row) throwNotFoundError(SESSION_NOT_FOUND);
		return { sessionId: session.id, deleted: true };
	};

	/** @info - GET /live/communities/:communityId/sessions?scope=upcoming|past */
	listCommunitySessions = async (
		authData: IAuthData,
		communityId: number,
		scope: CommunitySessionScope = "upcoming",
	): Promise<LiveSessionView[]> => {
		if (scope !== "upcoming" && scope !== "past") {
			throwBadRequestError(BAD_SCOPE);
		}
		const userId = Number(authData?.id);
		const { community, isOwnerOrAdmin } = await this.assertActiveMember(
			communityId,
			userId,
		);

		const db = getDb();
		const statuses: LiveSession["status"][] =
			scope === "upcoming" ? ["scheduled", "live"] : ["ended", "cancelled"];
		const rows = await db
			.select()
			.from(liveSessions)
			.where(
				and(
					eq(liveSessions.communityId, community.id),
					/* @info - Community events only. A course's live class belongs to the course
					 * and its community, but access to it is enrollment, not membership: listing it
					 * here would advertise a class most members cannot join. Course classes stay in
					 * the course and on the host's calendar. */
					isNull(liveSessions.courseId),
					isNull(liveSessions.deletedAt),
					inArray(liveSessions.status, statuses),
				),
			)
			.orderBy(
				scope === "upcoming"
					? asc(liveSessions.startsAt)
					: desc(liveSessions.startsAt),
			);

		const lessonsBySession = await this.lessonsForSessions(
			rows.map((row) => row.id),
		);
		return rows.map((row) => {
			const isHost = row.hostId === userId;
			return this.toSessionView(
				row,
				{ isHost, canModerate: isHost || isOwnerOrAdmin, canJoin: true },
				lessonsBySession.get(row.id) ?? null,
				community.slug,
			);
		});
	};

	/**
	 * @info - Every active member except the host hears about a new class. In-app only:
	 * the user chose option A, so there is no email and no reminder job (both deferred
	 * deliberately - a community Q&A does not need an email send path).
	 */
	private notifyMembers = async (
		community: { id: number; name: string },
		session: LiveSession,
	): Promise<void> => {
		try {
			const db = getDb();
			const recipients = await db
				.select({ userId: communityMembers.userId })
				.from(communityMembers)
				.where(
					and(
						eq(communityMembers.communityId, community.id),
						eq(communityMembers.status, "active"),
						ne(communityMembers.userId, session.hostId),
					),
				);
			if (recipients.length === 0) return;

			const notifier = NotificationService.getInstance();
			const when = session.startsAt
				? formatStartsAt(session.startsAt)
				: "when the host starts it";
			for (const recipient of recipients) {
				void notifier.notify(
					recipient.userId,
					NotificationType.COMMUNITY,
					`New live class in ${community.name}`,
					`${session.title} starts ${when}`,
					{ sessionId: session.id, communityId: community.id },
				);
			}
		} catch (error) {
			/* @info - A notification problem must never fail the class itself. */
			this.log.error(
				`live session ${session.id}: member notification failed`,
				error,
			);
		}
	};
}
