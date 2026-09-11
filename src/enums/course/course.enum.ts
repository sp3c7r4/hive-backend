export enum CourseDifficulty {
	BEGINNER = "beginner",
	INTERMEDIATE = "intermediate",
	ADVANCED = "advanced",
}

export enum CourseVisibility {
	PUBLIC = "public",
	PRIVATE = "private",
}

export enum CourseStatus {
	DRAFT = "draft",
	PUBLISHED = "published",
	ARCHIVED = "archived",
}

export enum LessonType {
	VIDEO = "video",
	PDF = "pdf",
	LIVE = "live",
	QUIZ = "quiz",
	ASSIGNMENT = "assignment",
	TEXT = "text",
	GOOGLE_DRIVE = "google_drive",
}

export enum LessonStatus {
	DRAFT = "draft",
	PUBLISHED = "published",
}

/** @info - API-level meeting discriminator on a lesson payload. Storage moved to
 * live_sessions.kind in migration 0028 (a lesson points at its session through
 * live_session_id), so this enum now describes the request/response shape only:
 * 'none' means the lesson has no session. */
export enum LessonMeetingType {
	NONE = "none",
	NATIVE = "native",
	EXTERNAL = "external",
}
