/**
 * @info - Centralised table-name constants.
 *         Use these everywhere instead of raw strings so renames are a single edit.
 */
export enum TableNames {
	USERS = "users",
	USER_ROLES = "user_roles",
	INSTRUCTOR_PROFILES = "instructor_profiles",
	STUDENT_PROFILES = "student_profiles",
	PARENT_PROFILES = "parent_profiles",
	PARENT_CHILD_LINKS = "parent_child_links",
	COMMUNITIES = "communities",
	COMMUNITY_MEMBERS = "community_members",
	COMMUNITY_INVITES = "community_invites",
	COURSES = "courses",
	MODULES = "modules",
	LESSONS = "lessons",
	QUIZ_QUESTIONS = "quiz_questions",
	QUIZ_ATTEMPTS = "quiz_attempts",
	ASSIGNMENT_SUBMISSIONS = "assignment_submissions",
	ENROLLMENTS = "enrollments",
	LESSON_PROGRESS = "lesson_progress",
	PAYMENTS = "payments",
	WITHDRAWALS = "withdrawals",
	REVIEWS = "reviews",
	INSTRUCTOR_REPLIES = "instructor_replies",
	CERTIFICATES = "certificates",
	CONVERSATIONS = "conversations",
	CONVERSATION_PARTICIPANTS = "conversation_participants",
	MESSAGES = "messages",
	NOTIFICATIONS = "notifications",
	USER_CREDENTIALS = "user_credentials",
}
