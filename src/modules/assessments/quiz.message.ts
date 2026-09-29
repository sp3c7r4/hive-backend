export const QuizMessages = {
	SUBMITTED: "Quiz submitted successfully",
	NO_QUESTIONS: "No quiz questions found for this lesson",
	NOT_FOUND: "Quiz question not found",
	CREATED: "Quiz question created successfully",
	UPDATED: "Quiz question updated successfully",
	DELETED: "Quiz question deleted successfully",
	/** @info - Ownership failure. Deliberately one message for every resource:
	 * the caller is told they do not own it, not whether the id exists. */
	FORBIDDEN: "You can only access quiz content in your own courses",
};
