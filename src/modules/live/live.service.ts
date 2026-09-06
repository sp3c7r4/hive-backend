import { and, eq, isNull } from "drizzle-orm";
import { StatusCodes } from "http-status-codes";
import { AccessToken } from "livekit-server-sdk";
import { config } from "@/config";
import { getDb } from "@/db/postgres.db";
import {
	throwBadRequestError,
	throwForbiddenError,
	throwNotFoundError,
	throwRateLimitError,
} from "@/helpers/errors/throw-errors";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { courses, lessons, modules } from "@/modules/courses/course.model";
import { enrollments } from "@/modules/enrollments/enrollment.model";
import { CacheService } from "@/services";

/** @info - Live session tokens are short-lived joins, not sessions */
const TOKEN_TTL_SECONDS = 2 * 60 * 60;
/** @info - Spec 19: 5 token requests/min/user */
const TOKEN_RATE_LIMIT = 5;

/** @info - Loads a lesson with its course. Throws 404 when missing. */
async function loadLessonWithCourse(lessonId: number) {
	const db = getDb();
	const [row] = await db
		.select({
			id: lessons.id,
			type: lessons.type,
			meetingType: lessons.meetingType,
			meetingUrl: lessons.meetingUrl,
			scheduledAt: lessons.scheduledAt,
			liveStatus: lessons.liveStatus,
			courseId: modules.courseId,
			instructorId: courses.instructorId,
		})
		.from(lessons)
		.innerJoin(modules, eq(lessons.moduleId, modules.id))
		.innerJoin(courses, eq(modules.courseId, courses.id))
		.where(eq(lessons.id, lessonId))
		.limit(1);
	if (!row) throwNotFoundError("Lesson not found.");
	return row!;
}

/** @info - Instructor of the course owns the lesson's live session */
function assertInstructorOwns(authData: IAuthData, instructorId: number) {
	if (Number(authData.id) !== instructorId) {
		throwForbiddenError("You do not own this lesson.");
	}
}

/** @info - LiveKit room name for a lesson (spec 19: room = lesson-<id>) */
export const roomNameForLesson = (lessonId: number): string =>
	`${config.livekit.roomPrefix}lesson-${lessonId}`;

export class LiveService {
	private static instance: LiveService;

	static getInstance(): LiveService {
		if (!this.instance) this.instance = new LiveService();
		return this.instance;
	}

	/** @info - Enforce the per-user token rate limit (sliding window, 5/min). */
	private enforceTokenRateLimit = async (userId: number) => {
		const redis = CacheService.getInstance().getRedisClient();
		const key = `ratelimit:livetoken:${userId}`;
		const count = await redis.incr(key);
		if (count === 1) await redis.expire(key, 60);
		if (count > TOKEN_RATE_LIMIT) {
			throwRateLimitError(
				"Too many join attempts. Wait a minute and try again.",
			);
		}
	};

	/**
	 * @info - POST /lessons/:id/live-token
	 * Issues a LiveKit join token. The instructor may publish (camera +
	 * mic); enrolled students subscribe only but may send chat data.
	 * Enrollment check mirrors the AI tutor gate (deletedAt is null).
	 */
	issueToken = async (authData: IAuthData, lessonId: number) => {
		await this.enforceTokenRateLimit(Number(authData.id));
		const lesson = await loadLessonWithCourse(lessonId);

		if (lesson.meetingType !== "native") {
			throwBadRequestError("This lesson has no LiveKit session.");
		}

		const isInstructor = Number(authData.id) === lesson.instructorId;
		if (!isInstructor) {
			const db = getDb();
			const [enrollment] = await db
				.select({ id: enrollments.id })
				.from(enrollments)
				.where(
					and(
						eq(enrollments.userId, Number(authData.id)),
						eq(enrollments.courseId, lesson.courseId),
						isNull(enrollments.deletedAt),
					),
				)
				.limit(1);
			if (!enrollment) {
				throwForbiddenError("You are not enrolled in this course.");
			}
		}

		const roomName = roomNameForLesson(lessonId);
		const displayName = [authData.firstName, authData.lastName]
			.filter(Boolean)
			.join(" ")
			.trim();
		const token = new AccessToken(
			config.livekit.apiKey,
			config.livekit.apiSecret,
			{
				identity: `user-${authData.id}`,
				name: displayName || `User ${authData.id}`,
				ttl: `${TOKEN_TTL_SECONDS}s`,
			},
		);
		token.addGrant({
			room: roomName,
			roomJoin: true,
			canPublish: isInstructor,
			canSubscribe: true,
			canPublishData: true,
		});

		return {
			token: await token.toJwt(),
			roomName,
			url: config.livekit.publicUrl,
			expiresIn: TOKEN_TTL_SECONDS,
		};
	};

	/** @info - POST /lessons/:id/go-live — instructor marks the session live */
	goLive = async (authData: IAuthData, lessonId: number) => {
		const lesson = await loadLessonWithCourse(lessonId);
		assertInstructorOwns(authData, lesson.instructorId);
		if (lesson.meetingType !== "native") {
			throwBadRequestError("This lesson has no LiveKit session.");
		}

		const db = getDb();
		await db
			.update(lessons)
			.set({
				liveStatus: "live",
				scheduledAt: lesson.scheduledAt ?? new Date(),
			})
			.where(eq(lessons.id, lessonId));

		return { lessonId, liveStatus: "live" as const };
	};

	/** @info - POST /lessons/:id/end-live — instructor ends the session */
	endLive = async (authData: IAuthData, lessonId: number) => {
		const lesson = await loadLessonWithCourse(lessonId);
		assertInstructorOwns(authData, lesson.instructorId);
		if (lesson.meetingType !== "native") {
			throwBadRequestError("This lesson has no LiveKit session.");
		}

		const db = getDb();
		await db
			.update(lessons)
			.set({ liveStatus: "ended" })
			.where(eq(lessons.id, lessonId));

		return { lessonId, liveStatus: "ended" as const };
	};
}
