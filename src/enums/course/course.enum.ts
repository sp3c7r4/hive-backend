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

/** @info - Meeting kinds for LIVE lessons. 'none' means the lesson is not
 * a scheduled meeting. Legacy rows pre-0021 are backfilled as external
 * when they carried a meeting link. */
export enum LessonMeetingType {
	NONE = "none",
	NATIVE = "native",
	EXTERNAL = "external",
}

export enum LessonLiveStatus {
	SCHEDULED = "scheduled",
	LIVE = "live",
	ENDED = "ended",
}
