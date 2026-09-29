export const QuizMessages = {
	SUBMITTED: "Quiz submitted successfully",
	NO_QUESTIONS: "No quiz questions found for this lesson",
	NOT_FOUND: "Quiz question not found",
	CREATED: "Quiz question created successfully",
	UPDATED: "Quiz question updated successfully",
	DELETED: "Quiz question deleted successfully",
	/* @info - Ownership failure. Deliberately one message for every resource: the
	 * caller is told they do not own it, not whether the id exists. */
	FORBIDDEN: "You can only access quiz content in your own courses",

	/* @info - Assessment attempt policy. `NOT_ASSESSMENT` is a bad request rather
	 * than a 404: the lesson exists and the caller may read it, it is simply not
	 * the kind of lesson this endpoint acts on. */
	NOT_ASSESSMENT: "This lesson is not an assessment",
	ATTEMPT_SUBMITTED: "This assessment has already been submitted",
	ATTEMPT_EXPIRED: "Time is up for this assessment",
	ATTEMPT_NOT_STARTED: "This assessment has not been started",
};
