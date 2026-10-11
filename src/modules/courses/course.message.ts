export const CourseMessages = {
	NOT_FOUND: "Course not found",
	DELETED: "Course deleted",
	CREATED: "Course created",
	LEADERBOARD_FETCHED: "Leaderboard fetched successfully",
};

export const ModuleMessages = {
	NOT_FOUND: "Module not found",
	DELETED: "Module deleted",
	CREATED: "Module created",
	REORDERED: "Modules reordered successfully",
	/* @info - A subset, a duplicate or an id from another course is refused outright:
	 * accepting it would silently drop or reorder part of the list. */
	ORDER_MISMATCH: "The order must list every module in this course exactly once.",
	UNLOCK_AT_INVALID: "The unlock date must be a valid date",
};

export const LessonMessages = {
	NOT_PUBLISHED: "This lesson is not published yet",
	MODULE_NOT_OPEN: "This module is not open yet",
	NOT_FOUND: "Lesson not found",
	DELETED: "Lesson deleted",
	CREATED: "Lesson created",
	REORDERED: "Lessons reordered successfully",
	ORDER_MISMATCH: "The order must list every lesson in this module exactly once.",
};
