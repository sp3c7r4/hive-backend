export const SubmissionMessages = {
	NOT_FOUND: "Submission not found",
	GRADED: "Submission graded successfully",
	LISTED: "Submissions fetched successfully",
	SETTINGS_UPDATED: "Assignment settings updated successfully",
	COURSE_NOT_FOUND: "Course not found",
	/** @info - Ownership failure. Deliberately one message for every resource:
	 * the caller is told they do not own it, not whether the id exists. */
	FORBIDDEN: "You can only access assignments in your own courses",
};
