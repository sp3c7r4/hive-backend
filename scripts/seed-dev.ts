/**
 * Dev fixture seeder — the accounts you log in as, and a course tree to click
 * through. Re-runnable: it deletes its own namespace and rebuilds it, so the
 * result is the same every time and never doubles up.
 *
 * Everything it owns is namespaced — `dev-*@hive.dev`, `dev-*` slugs — and it
 * touches nothing else. Nothing is shared with tests: the test suites create
 * their own fixtures and clean up after themselves.
 *
 * Run it with `npm run seed:dev` after `npm run migrate`.
 */
import { hash } from "@node-rs/argon2";
import { Pool } from "pg";
import { config } from "@/config";
import { MEMORY_COST, PARALLELISM, TIME_COST } from "@/constants";

const pool = new Pool({ connectionString: config.db.uri });

const rows = async (sql: string, params: unknown[] = []) =>
	(await pool.query(sql, params)).rows as any[];
const row = async (sql: string, params: unknown[] = []) =>
	(await rows(sql, params))[0];

/** @info - One password for every dev account. It is in this file on purpose:
 *         it is a local fixture, and needing to remember four of them is worse
 *         than needing to remember one. */
const DEV_PASSWORD = "Dev@1234";

/**
 * @info - `hive.dev` rather than a `.com`: a seeded address should never be
 *         something that could route to a real mailbox if a dev flow sends mail.
 */
const DOMAIN = "hive.dev";

const ACCOUNTS = [
	{
		key: "admin",
		first: "Dev",
		last: "Admin",
		email: `dev-admin@${DOMAIN}`,
		role: "admin",
	},
	{
		key: "instructor",
		first: "Dev",
		last: "Instructor",
		email: `dev-instructor@${DOMAIN}`,
		role: "instructor",
	},
	{
		key: "student",
		first: "Dev",
		last: "Student",
		email: `dev-student@${DOMAIN}`,
		role: "student",
	},
	{
		key: "student2",
		first: "Ada",
		last: "Second",
		email: `dev-student2@${DOMAIN}`,
		role: "student",
	},
	{
		key: "parent",
		first: "Dev",
		last: "Parent",
		email: `dev-parent@${DOMAIN}`,
		role: "parent",
	},
] as const;

const COMMUNITY_SLUG = "dev-community";
const COURSE_SLUGS = [
	"dev-course-start",
	"dev-course-paid",
	"dev-course-draft",
];

/* ---------------------------------------------------------------- */
/*  Preflight                                                        */
/* ---------------------------------------------------------------- */

/* @info - The assessment lesson type and its time limit arrive with migration
 * 0032. Failing here, by name, beats a foreign-key or enum error halfway through
 * the seed with half a fixture on disk. */
const preflight = await row(
	`SELECT
		EXISTS (
			SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
			WHERE t.typname = 'lesson_type' AND e.enumlabel = 'assessment'
		) AS has_assessment,
		EXISTS (
			SELECT 1 FROM information_schema.columns
			WHERE table_name = 'lessons' AND column_name = 'time_limit_minutes'
		) AS has_time_limit`,
);
if (!preflight?.has_assessment || !preflight?.has_time_limit) {
	console.error(
		"✖ This database is missing migration 0032 (assessment lessons).\n" +
			"  Run `npm run migrate` first, then seed again.",
	);
	await pool.end();
	process.exit(1);
}

/* ---------------------------------------------------------------- */
/*  Accounts                                                         */
/* ---------------------------------------------------------------- */

const passwordHash = await hash(DEV_PASSWORD, {
	memoryCost: MEMORY_COST,
	parallelism: PARALLELISM,
	timeCost: TIME_COST,
});

const userIds: Record<string, number> = {};
for (const account of ACCOUNTS) {
	const created = await row(
		`INSERT INTO users (first_name, last_name, email, password_hash, onboarded)
		 VALUES ($1, $2, $3, $4, true)
		 ON CONFLICT (lower(email)) DO UPDATE SET
			first_name = EXCLUDED.first_name,
			last_name = EXCLUDED.last_name,
			password_hash = EXCLUDED.password_hash,
			onboarded = true,
			deleted_at = NULL
		 RETURNING id`,
		[account.first, account.last, account.email, passwordHash],
	);
	userIds[account.key] = created.id as number;

	/* @info - Roles are replaced, not merged: migration 0027 allows one non-admin
	 * role per user, so re-seeding an account whose role changed would otherwise
	 * hit `uq_user_role_single_working` and stop the seed. */
	await rows(`DELETE FROM user_roles WHERE user_id = $1 AND role <> 'admin'`, [
		created.id,
	]);
	await rows(
		`INSERT INTO user_roles (user_id, role) VALUES ($1, $2)
		 ON CONFLICT (user_id, role) DO NOTHING`,
		[created.id, account.role],
	);
}

/* @info - `instructor_profiles` needs a row per instructor. */
for (const [key, isAdmin] of [
	["admin", true],
	["instructor", false],
] as const) {
	const userId = userIds[key];
	await rows(
		`UPDATE instructor_profiles SET is_admin = $2 WHERE user_id = $1`,
		[userId, isAdmin],
	);
	await rows(
		`INSERT INTO instructor_profiles (user_id, is_admin)
		 SELECT $1, $2
		 WHERE NOT EXISTS (SELECT 1 FROM instructor_profiles WHERE user_id = $1)`,
		[userId, isAdmin],
	);
}

/** @info - A missing account id is a broken seed, not an empty fixture: fail here
 *  rather than writing rows with `undefined` into a foreign key. */
const userId = (key: string): number => {
	const found = userIds[key];
	if (!found) throw new Error(`seed: the ${key} account was not created`);
	return found;
};

const instructorId = userId("instructor");
const studentId = userId("student");
const student2Id = userId("student2");

/* @info - The admin also holds the instructor role: `requireInstructor` gates the
 * instructor screens by reading user_roles, and migration 0027 allows an admin
 * plus one non-admin role per user. Otherwise an admin login could not open the
 * course builder. */
await rows(
	`INSERT INTO user_roles (user_id, role) VALUES ($1, 'instructor')
	 ON CONFLICT (user_id, role) DO NOTHING`,
	[userId("admin")],
);

/* ---------------------------------------------------------------- */
/*  Reset this seeder's own namespace                                */
/* ---------------------------------------------------------------- */

/* @info - Delete and rebuild rather than upsert every child row: the tree is
 * ten-odd tables deep and a partial re-run is the one state that must not exist.
 * Deleting the courses cascades modules, lessons, questions, attempts, sessions,
 * enrolments and progress. Nothing outside these slugs is touched. */
await rows(`DELETE FROM courses WHERE slug = ANY($1)`, [COURSE_SLUGS]);

try {
	await rows(`DELETE FROM communities WHERE slug = $1`, [COMMUNITY_SLUG]);
} catch (e: any) {
	/* @info - A course made by hand in this community blocks the delete
	 * (courses.community_id is ON DELETE RESTRICT). Reuse it instead of failing. */
	if (e?.code !== "23503") throw e;
	console.log("• dev-community kept: something else still references it");
}

/* ---------------------------------------------------------------- */
/*  Community                                                        */
/* ---------------------------------------------------------------- */

const community = await row(
	`INSERT INTO communities (owner_id, name, slug, visibility, description)
	 VALUES ($1, 'Dev Community', $2, 'public', 'Seeded community for local work.')
	 RETURNING id`,
	[instructorId, COMMUNITY_SLUG],
);
const communityId = community.id as number;

for (const [userId, role, memberRole] of [
	[instructorId, "instructor", "owner"],
	[studentId, "student", "member"],
	[student2Id, "student", "member"],
] as const) {
	await rows(
		`INSERT INTO community_members (community_id, user_id, role, member_role, status)
		 VALUES ($1, $2, $3, $4, 'active')
		 ON CONFLICT (community_id, user_id) DO NOTHING`,
		[communityId, userId, role, memberRole],
	);
}

/* ---------------------------------------------------------------- */
/*  Courses                                                          */
/* ---------------------------------------------------------------- */

const makeCourse = async (input: {
	slug: string;
	title: string;
	subtitle: string;
	description: string;
	price: number;
	isFree: boolean;
	status: "draft" | "published";
}) =>
	(
		await row(
			`INSERT INTO courses (
				instructor_id, community_id, title, slug, subtitle, description,
				category, difficulty, visibility, price, is_free, status,
				offer_certificate, min_completion_percent, min_quiz_score_percent
			 )
			 VALUES ($1, $2, $3, $4, $5, $6, 'Development', 'beginner', 'public',
				$7, $8, $9, true, 80, 70)
			 RETURNING id`,
			[
				instructorId,
				communityId,
				input.title,
				input.slug,
				input.subtitle,
				input.description,
				input.price,
				input.isFree,
				input.status,
			],
		)
	).id as number;

const startCourseId = await makeCourse({
	slug: "dev-course-start",
	title: "Dev Course — Getting Started",
	subtitle: "Every lesson type, end to end",
	description:
		"Seeded course with text, video, quiz, assessment and assignment lessons.",
	price: 0,
	isFree: true,
	status: "published",
});

const paidCourseId = await makeCourse({
	slug: "dev-course-paid",
	title: "Dev Course — Paid",
	subtitle: "Exercises the checkout gate",
	description: "Nothing is enrolled in this one, so it shows the paywall.",
	price: 50_000,
	isFree: false,
	status: "published",
});

const draftCourseId = await makeCourse({
	slug: "dev-course-draft",
	title: "Dev Course — Draft",
	subtitle: "Not visible to students",
	description: "A draft, so it stays out of Explore and out of certificates.",
	price: 0,
	isFree: true,
	status: "draft",
});

const makeModule = async (courseId: number, title: string, sortOrder: number) =>
	(
		await row(
			`INSERT INTO modules (course_id, title, sort_order) VALUES ($1, $2, $3) RETURNING id`,
			[courseId, title, sortOrder],
		)
	).id as number;

const makeLesson = async (input: {
	moduleId: number;
	title: string;
	type: "text" | "video" | "quiz" | "assessment" | "assignment";
	sortOrder: number;
	status?: "draft" | "published";
	freePreview?: boolean;
	videoUrl?: string | null;
	timeLimitMinutes?: number | null;
}) =>
	(
		await row(
			`INSERT INTO lessons (
				module_id, title, type, sort_order, status, free_preview,
				duration, video_url, time_limit_minutes
			 )
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			 RETURNING id`,
			[
				input.moduleId,
				input.title,
				input.type,
				input.sortOrder,
				input.status ?? "published",
				input.freePreview ?? false,
				"10 min",
				input.videoUrl ?? null,
				input.timeLimitMinutes ?? null,
			],
		)
	).id as number;

const insertQuestions = async (
	lessonId: number,
	list: Array<{ text: string; options: string[]; correct: string }>,
) => {
	const ids: number[] = [];
	for (const [index, item] of list.entries()) {
		const created = await row(
			`INSERT INTO quiz_questions (lesson_id, type, text, options, correct_answer, points, sort_order)
			 VALUES ($1, 'multiple', $2, $3, $4, 1, $5)
			 RETURNING id`,
			[lessonId, item.text, JSON.stringify(item.options), item.correct, index],
		);
		ids.push(created.id as number);
	}
	return ids;
};

/* ── Getting Started: two modules, one of every lesson type ───── */

const foundations = await makeModule(startCourseId, "Foundations", 0);
const welcomeLessonId = await makeLesson({
	moduleId: foundations,
	title: "Welcome",
	type: "text",
	sortOrder: 0,
	freePreview: true,
});
const videoLessonId = await makeLesson({
	moduleId: foundations,
	title: "How the course works",
	type: "video",
	sortOrder: 1,
	videoUrl: "https://example.test/dev/welcome.mp4",
});

const gradedWork = await makeModule(startCourseId, "Graded work", 1);
const quizLessonId = await makeLesson({
	moduleId: gradedWork,
	title: "Module quiz",
	type: "quiz",
	sortOrder: 0,
});
const quizQuestionIds = await insertQuestions(quizLessonId, [
	{
		text: "Which hook holds state in a React function component?",
		options: ["useState", "useFetch", "useStore", "useStateful"],
		correct: "useState",
	},
	{
		text: "What does `await` do?",
		options: [
			"Pauses until the promise settles",
			"Blocks the thread",
			"Copies a value",
		],
		correct: "Pauses until the promise settles",
	},
	{
		text: "Which of these is NOT a JavaScript primitive?",
		options: ["object", "string", "number"],
		correct: "object",
	},
]);

const assessmentLessonId = await makeLesson({
	moduleId: gradedWork,
	title: "Final assessment",
	type: "assessment",
	sortOrder: 1,
	timeLimitMinutes: 30,
});
/* @info - Named, because the seeded answers below refer to these questions by
 * text: one source of truth for what the paper is. */
const ASSESSMENT_QUESTIONS = [
	{
		text: "Which command lists the files in a directory?",
		options: ["ls", "cd", "mv"],
		correct: "ls",
	},
	{
		text: "What is the point of a lockfile?",
		options: ["Reproducible installs", "Faster builds", "Smaller bundles"],
		correct: "Reproducible installs",
	},
];
const assessmentQuestionIds = await insertQuestions(
	assessmentLessonId,
	ASSESSMENT_QUESTIONS,
);

/** @info - Checked read: an empty list here would seed an assessment with no
 *  paper, which the screens would then show as "no questions yet". */
const firstAssessmentQuestion = ASSESSMENT_QUESTIONS[0];
if (!firstAssessmentQuestion) {
	throw new Error("seed: the assessment question list is empty");
}

const assignmentLessonId = await makeLesson({
	moduleId: gradedWork,
	title: "Capstone submission",
	type: "assignment",
	sortOrder: 2,
});

/* @info - One draft lesson so the "drafts do not count" rule is visible without
 * having to author one by hand. */
await makeLesson({
	moduleId: gradedWork,
	title: "Coming soon (draft)",
	type: "text",
	sortOrder: 3,
	status: "draft",
});

/* ── The other two courses need only to exist ─────────────────── */

const paidModule = await makeModule(paidCourseId, "What you get", 0);
await makeLesson({
	moduleId: paidModule,
	title: "Preview lesson",
	type: "text",
	sortOrder: 0,
	freePreview: true,
});

const draftModule = await makeModule(draftCourseId, "Draft module", 0);
await makeLesson({
	moduleId: draftModule,
	title: "Draft lesson",
	type: "text",
	sortOrder: 0,
	status: "draft",
});

/* ---------------------------------------------------------------- */
/*  Enrolment, progress, attempts and sessions                       */
/* ---------------------------------------------------------------- */

const enroll = async (
	userId: number,
	courseId: number,
	progressPercent: number,
) =>
	(
		await row(
			`INSERT INTO enrollments (user_id, course_id, progress_percent)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (user_id, course_id) DO UPDATE SET progress_percent = EXCLUDED.progress_percent
			 RETURNING id`,
			[userId, courseId, progressPercent],
		)
	).id as number;

const studentEnrollmentId = await enroll(studentId, startCourseId, 40);
const secondEnrollmentId = await enroll(student2Id, startCourseId, 20);

const completeLesson = async (enrollmentId: number, lessonId: number) => {
	await rows(
		`INSERT INTO lesson_progress (enrollment_id, lesson_id, completed, completed_at)
		 VALUES ($1, $2, true, now())
		 ON CONFLICT (enrollment_id, lesson_id) DO UPDATE SET completed = true, completed_at = now()`,
		[enrollmentId, lessonId],
	);
};

/* @info - The first student is two lessons in and has taken the quiz and the
 * assessment; the second is one lesson in with an assessment still open. Between
 * them, every state the feature has is on screen: a ranked row, a graded quiz in
 * the grading tab, a half-finished attempt that must NOT appear there, and
 * lessons left to unlock. */
await completeLesson(studentEnrollmentId, welcomeLessonId);
await completeLesson(studentEnrollmentId, videoLessonId);
await completeLesson(secondEnrollmentId, welcomeLessonId);

const seedAnswer = async (input: {
	userId: number;
	lessonId: number;
	questionId: number;
	selectedAnswer: string;
	isCorrect: boolean;
}) =>
	rows(
		`INSERT INTO quiz_attempts (user_id, lesson_id, question_id, selected_answer, is_correct, attempted_at)
		 VALUES ($1, $2, $3, $4, $5, now())
		 ON CONFLICT DO NOTHING`,
		[
			input.userId,
			input.lessonId,
			input.questionId,
			input.selectedAnswer,
			input.isCorrect,
		],
	);

/** @info - Record one answer against a question named by its text.
 *
 *  Pairing by text rather than by index means the question lists above can be
 *  reordered without silently attaching a student's answer to the wrong question —
 *  the failure is a thrown error, not a wrong score.
 *
 *  `graded` is false for autosave, which does not score: an open assessment's rows
 *  carry no verdict until the attempt closes and the server grades them. */
const answerQuestion = async (input: {
	userId: number;
	lessonId: number;
	questionText: string;
	selectedAnswer: string;
	graded: boolean;
}) => {
	const question = await row(
		`SELECT id, correct_answer FROM quiz_questions WHERE lesson_id = $1 AND text = $2`,
		[input.lessonId, input.questionText],
	);
	if (!question) {
		throw new Error(
			`seed: no question "${input.questionText}" in lesson ${input.lessonId}`,
		);
	}
	await seedAnswer({
		userId: input.userId,
		lessonId: input.lessonId,
		questionId: question.id as number,
		selectedAnswer: input.selectedAnswer,
		isCorrect:
			input.graded &&
			input.selectedAnswer === (question.correct_answer as string),
	});
};

/* @info - Two of three right on the quiz: the grading tab shows a real score, and
 * the certificate gate sees a quiz that was attempted but not passed (70%). */
/* @info - Two of three right: the grading tab shows a real score, and the
 * certificate gate sees a quiz that was attempted and not passed. */
await answerQuestion({
	userId: studentId,
	lessonId: quizLessonId,
	questionText: "Which hook holds state in a React function component?",
	selectedAnswer: "useState",
	graded: true,
});
await answerQuestion({
	userId: studentId,
	lessonId: quizLessonId,
	questionText: "What does `await` do?",
	selectedAnswer: "Blocks the thread",
	graded: true,
});
await answerQuestion({
	userId: studentId,
	lessonId: quizLessonId,
	questionText: "Which of these is NOT a JavaScript primitive?",
	selectedAnswer: "object",
	graded: true,
});

/* @info - A SUBMITTED assessment, graded: this is what makes the certificate gate
 * and (later) the leaderboard count it. Both answers right, so the pass is real. */
await rows(
	`INSERT INTO assessment_sessions (user_id, lesson_id, started_at, submitted_at)
	 VALUES ($1, $2, now() - interval '25 minutes', now() - interval '5 minutes')
	 ON CONFLICT (user_id, lesson_id) DO UPDATE SET
		started_at = EXCLUDED.started_at, submitted_at = EXCLUDED.submitted_at`,
	[studentId, assessmentLessonId],
);
for (const question of ASSESSMENT_QUESTIONS) {
	await answerQuestion({
		userId: studentId,
		lessonId: assessmentLessonId,
		questionText: question.text,
		selectedAnswer: question.correct,
		graded: true,
	});
}

/* @info - An OPEN assessment with one answer saved: it must be invisible to the
 * certificate gate and to the grading tab until the session closes, and the
 * student's screen must offer Resume rather than Start. */
await rows(
	`INSERT INTO assessment_sessions (user_id, lesson_id, started_at, submitted_at)
	 VALUES ($1, $2, now() - interval '2 minutes', NULL)
	 ON CONFLICT (user_id, lesson_id) DO UPDATE SET
		started_at = EXCLUDED.started_at, submitted_at = NULL`,
	[student2Id, assessmentLessonId],
);
await answerQuestion({
	userId: student2Id,
	lessonId: assessmentLessonId,
	questionText: firstAssessmentQuestion.text,
	selectedAnswer: "ls",
	/* @info - Ungraded on purpose: autosave does not score, and an expired attempt
	 * is graded later, on read. */
	graded: false,
});

/* @info - The parent is linked to the first student, so a parent-scoped screen has
 * something to show instead of an empty account. */
await rows(
	`INSERT INTO parent_child_links (parent_id, student_id, linked_email, status)
	 VALUES ($1, $2, $3, 'active')
	 ON CONFLICT (parent_id, student_id) DO UPDATE SET status = 'active'`,
	[userId("parent"), studentId, ACCOUNTS[2].email],
);

await rows(
	`INSERT INTO assignment_submissions (user_id, lesson_id, text, status, submitted_at)
	 VALUES ($1, $2, $3, 'submitted', now())
	 ON CONFLICT (user_id, lesson_id) DO UPDATE SET
		text = EXCLUDED.text, status = 'submitted', submitted_at = now()`,
	[
		studentId,
		assignmentLessonId,
		"Seeded submission: my capstone lives in a repository, see the description.",
	],
);

/* ---------------------------------------------------------------- */
/*  Self-check                                                       */
/* ---------------------------------------------------------------- */

/**
 * @info - Verify what was seeded, by counting it.
 *
 * A seeder that half-finishes is worse than one that fails: the screens look
 * populated and the missing rows surface later as a mystery. These are the
 * invariants a login depends on, checked against the database rather than
 * assumed from the inserts above.
 */
const expectAtLeast = async (
	label: string,
	sql: string,
	expected: number,
	params: unknown[] = [],
) => {
	const found = (await row(sql, params))?.n ?? 0;
	if (Number(found) < expected) {
		throw new Error(
			`seed: expected at least ${expected} ${label}, found ${found}. The database may be in a partial state — re-run the seed.`,
		);
	}
	return Number(found);
};

await expectAtLeast(
	"dev accounts",
	`SELECT count(*)::int n FROM users WHERE email LIKE '%@${DOMAIN}'`,
	ACCOUNTS.length,
);
await expectAtLeast(
	"seeded courses",
	`SELECT count(*)::int n FROM courses WHERE slug = ANY($1)`,
	COURSE_SLUGS.length,
	[COURSE_SLUGS],
);
await expectAtLeast(
	"published lessons in the getting-started course",
	`SELECT count(*)::int n FROM lessons l JOIN modules m ON m.id = l.module_id
	 WHERE m.course_id = $1 AND l.status = 'published'`,
	5,
	[startCourseId],
);
await expectAtLeast(
	"enrolments in the getting-started course",
	`SELECT count(*)::int n FROM enrollments WHERE course_id = $1`,
	2,
	[startCourseId],
);
await expectAtLeast(
	"assessment sessions",
	`SELECT count(*)::int n FROM assessment_sessions`,
	2,
);

/* ---------------------------------------------------------------- */
/*  What you got                                                     */
/* ---------------------------------------------------------------- */

const publishedLessons = await rows(
	`SELECT count(*)::int n FROM lessons l
	 JOIN modules m ON m.id = l.module_id
	 WHERE m.course_id = $1 AND l.status = 'published'`,
	[startCourseId],
);

console.log(`
✅ Seeded. Log in with any of these — password for all of them: ${DEV_PASSWORD}

   dev-admin@${DOMAIN}        admin (also holds the instructor role)
   dev-instructor@${DOMAIN}   instructor — owns every seeded course
   dev-student@${DOMAIN}      student    — enrolled, quiz + assessment taken
   dev-student2@${DOMAIN}     student    — enrolled, assessment still open
   dev-parent@${DOMAIN}       parent

   Course "Dev Course — Getting Started" (slug dev-course-start)
     ${publishedLessons[0]?.n ?? 0} published lessons + 1 draft, ${quizQuestionIds.length} quiz questions, ${assessmentQuestionIds.length} assessment questions (30 min limit)
   Course "Dev Course — Paid"  (slug dev-course-paid)  paywall, nobody enrolled
   Course "Dev Course — Draft" (slug dev-course-draft) hidden from students
   Community "Dev Community" (slug ${COMMUNITY_SLUG}) with both students as members

   ids: community=${communityId} start=${startCourseId} paid=${paidCourseId} draft=${draftCourseId}
`);

await pool.end();
