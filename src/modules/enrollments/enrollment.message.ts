export const EnrollmentMessages = {
	NOT_FOUND: "Enrollment not found",
	CREATED: "Enrollment created",
	/* @info - One message for every enrollment the caller does not own: it names no
	 * resource, so a 403 says only "not yours". Existence is still disclosed by the
	 * status pair (404 missing, 403 not yours), as in CourseService/QuizService — the
	 * disclosure is the code, not this string. */
	FORBIDDEN: "You can only access your own enrollments",
};

export const LessonProgressMessages = {
	MARKED_COMPLETE: "Lesson marked complete",
};
