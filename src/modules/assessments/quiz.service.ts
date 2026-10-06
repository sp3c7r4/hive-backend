import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import {
	throwBadRequestError,
	throwConflictError,
	throwForbiddenError,
	throwNotFoundError,
} from "@/helpers/errors/throw-errors";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import {
	CourseMessages,
	LessonMessages,
} from "@/modules/courses/course.message";
import { lessons, modules } from "@/modules/courses/course.model";
import {
	CourseRepository,
	LessonRepository,
	ModuleRepository,
} from "@/modules/courses/course.repository";
import {
	assertLessonVisibleTo,
	isLessonVisibleTo,
} from "@/modules/courses/lesson-visibility";
import { EnrollmentRepository } from "@/modules/enrollments/enrollment.repository";
import { users } from "@/modules/user/user.model";
import { serviceLogger } from "@/utils";
import type { NewQuizQuestion } from "./assessment.model";
import { assessmentSessions, quizAttempts } from "./assessment.model";
import {
	type AssessmentStatus,
	assessmentDeadline,
	assessmentState,
	withinGrace,
} from "./assessment-state";
import { QuizMessages } from "./quiz.message";
import {
	AssessmentSessionRepository,
	QuizAttemptRepository,
	QuizQuestionRepository,
} from "./quiz.repository";

interface QuizSubmission {
	questionId: number;
	selectedAnswer: string;
}

export class QuizService {
	private static instance: QuizService;
	private questions: QuizQuestionRepository;
	private attempts: QuizAttemptRepository;
	private sessions: AssessmentSessionRepository;
	private courses: CourseRepository;
	private modules: ModuleRepository;
	private lessons: LessonRepository;
	private enrollments: EnrollmentRepository;
	/** @info - Injected rather than called directly so the stub-based suites can say
	 *  whether a lesson is visible, exactly as they stub the repositories: the real
	 *  implementation reads the database, which those tests deliberately do not
	 *  build. */
	private lessonVisibility = isLessonVisibleTo;

	/** @info - Utilities */
	private readonly log = serviceLogger("Quiz");

	static getInstance(): QuizService {
		if (!this.instance) this.instance = new QuizService();
		return this.instance;
	}

	private constructor() {
		this.questions = QuizQuestionRepository.getInstance();
		this.attempts = QuizAttemptRepository.getInstance();
		this.sessions = AssessmentSessionRepository.getInstance();
		this.courses = CourseRepository.getInstance();
		this.modules = ModuleRepository.getInstance();
		this.lessons = LessonRepository.getInstance();
		this.enrollments = EnrollmentRepository.getInstance();
	}

	/**
	 * @info - Autosave. The assessment-only variant of writing an answer: it exists
	 *         so an attempt survives a refresh, and it returns no score and no
	 *         correctness, so it cannot be used to test guesses against the paper.
	 *
	 *         Requires an OPEN session. Grace is deliberately not honoured here —
	 *         it exists so a submit that started before the bell is not lost, not to
	 *         keep accepting fresh answers after it.
	 */
	autosaveAttempt = async (
		authData: IAuthData,
		input: { lessonId: number; questionId: number; selectedAnswer: string },
	) => {
		await this.assertLessonVisible(authData, input.lessonId);
		const lesson = await this.assertAssessmentLesson(input.lessonId);
		const userId = Number(authData.id);
		await this.assertEnrolledInLesson(userId, input.lessonId);

		const session = await this.sessions.findByUserAndLesson(userId, lesson.id);
		const status = assessmentState({
			session: session ?? null,
			timeLimitMinutes: lesson.timeLimitMinutes ?? null,
			now: new Date(),
		});

		if (status === "submitted") {
			return throwBadRequestError(QuizMessages.ATTEMPT_SUBMITTED);
		}
		if (status === "expired") {
			return throwBadRequestError(QuizMessages.ATTEMPT_EXPIRED);
		}
		if (status === "not_started") {
			return throwBadRequestError(QuizMessages.ATTEMPT_NOT_STARTED);
		}

		/* @info - One row per (user, lesson, question): the same upsert `submit`
		 * does, minus the scoring. */
		const existing = await this.attempts.findByUserAndQuestion(
			userId,
			input.questionId,
		);
		if (existing) {
			await this.attempts.update(existing.id, {
				selectedAnswer: input.selectedAnswer,
				attemptedAt: new Date(),
			} as any);
		} else {
			await this.attempts.create({
				userId,
				lessonId: lesson.id,
				questionId: input.questionId,
				selectedAnswer: input.selectedAnswer,
			} as any);
		}

		return { serverNow: new Date() };
	};

	/**
	 * @info - D9: an expired attempt is graded on whatever was autosaved, and there
	 *         is no background job — the score is computable from the rows plus the
	 *         questions, so it is computed the first time somebody asks for it.
	 *         Idempotent, and it never touches `attempted_at` (that is when the
	 *         student answered, not when they were graded).
	 */
	private gradeExpiredAssessment = async (userId: number, lessonId: number) => {
		const rows = await this.attempts.findByUserAndLesson(userId, lessonId);
		if (rows.length === 0) return;

		const questions = await this.questions.findByLesson(lessonId);
		const correctById = new Map(
			questions.map((question) => [question.id, question.correctAnswer]),
		);

		for (const row of rows) {
			if (row.isCorrect) continue;
			const correct = correctById.get(row.questionId);
			if (correct === undefined) continue;
			if (row.selectedAnswer === correct) {
				await this.attempts.update(row.id, { isCorrect: true } as any);
			}
		}
	};

	/** @info - Spec §4.2: a successful submit closes the attempt. Without this the
	 *  session stays open forever and "may be taken exactly once" is not enforced,
	 *  because `submit` accepts any open session. No-op for quizzes, which have no
	 *  session row at all. */
	private markAssessmentSubmitted = async (
		userId: number,
		lessonId: number,
	): Promise<void> => {
		const lesson = await this.assertLessonIfAssessment(lessonId);
		if (!lesson) return;

		const session = await this.sessions.findByUserAndLesson(userId, lessonId);
		if (!session || session.submittedAt) return;
		await this.sessions.update(session.id, { submittedAt: new Date() } as any);
	};

	/**
	 * @info - The attempt policy, in the one place that writes `quiz_attempts`:
	 *         `submit` is the sole writer, so this single guard covers both the quiz
	 *         and the assessment path from every caller.
	 *
	 *         Quizzes are untouched (no session row exists for them, and none is
	 *         required). An assessment accepts a submit while it is open, and for
	 *         GRACE_SECONDS after the deadline — the case the grace window exists
	 *         for is a round trip that started before the bell and landed after it.
	 */
	/** @info - The module's lesson list hides unpublished rows; this refuses them one
	 * at a time. Same rule, one implementation: `isLessonVisibleTo`. */
	private assertLessonVisible = async (
		authData: IAuthData,
		lessonId: number,
	): Promise<void> => {
		/* @info - The refusal says which rule refused: a module that has not opened yet says
		 * so, instead of claiming the lesson is unpublished. The injectable check stays, so a
		 * suite with no lesson rows still replaces it. */
		await assertLessonVisibleTo(authData, lessonId, this.lessonVisibility);
	};

	private assertAttemptOpen = async (
		authData: IAuthData,
		lessonId: number,
	): Promise<void> => {
		const lesson = await this.assertLessonIfAssessment(lessonId);
		if (!lesson) return;

		const userId = Number(authData.id);
		await this.assertEnrolledInLesson(userId, lessonId);

		const session = await this.sessions.findByUserAndLesson(userId, lessonId);
		const timing = {
			session: session ?? null,
			timeLimitMinutes: lesson.timeLimitMinutes ?? null,
			now: new Date(),
		};

		if (assessmentState(timing) === "submitted") {
			return throwBadRequestError(QuizMessages.ATTEMPT_SUBMITTED);
		}
		/* @info - Checked before grace: `withinGrace` is false with no session at all
		 * (there is nothing to send an answer against), so relying on it here would
		 * report "time is up" for an attempt that was never started. */
		if (assessmentState(timing) === "not_started") {
			return throwBadRequestError(QuizMessages.ATTEMPT_NOT_STARTED);
		}
		if (!withinGrace(timing)) {
			return throwBadRequestError(QuizMessages.ATTEMPT_EXPIRED);
		}
	};

	/** @info - The lesson, or `null` when it is not an assessment: callers that
	 *  must not refuse a quiz need to tell "not an assessment" from "missing". */
	private assertLessonIfAssessment = async (lessonId: number) => {
		const lesson = await this.lessons.findById(Number(lessonId));
		if (!lesson) return throwNotFoundError(LessonMessages.NOT_FOUND);
		return lesson.type === "assessment" ? lesson : null;
	};

	/**
	 * @info - A student may only attempt a course they are enrolled in. The quiz
	 *         module has never checked this; assessments do, because a one-shot exam
	 *         is the thing worth bypassing. Resolved lesson → module → course.
	 */
	private assertEnrolledInLesson = async (
		userId: number,
		lessonId: number,
	): Promise<void> => {
		const lesson = await this.lessons.findById(Number(lessonId));
		if (!lesson) return throwNotFoundError(LessonMessages.NOT_FOUND);
		const mod = await this.modules.findById(Number(lesson.moduleId));
		if (!mod || mod.courseId == null) {
			return throwNotFoundError(LessonMessages.NOT_FOUND);
		}
		const enrollment = await this.enrollments.findByUserAndCourse(
			userId,
			Number(mod.courseId),
		);
		if (!enrollment) return throwForbiddenError(QuizMessages.NOT_ENROLLED);
	};

	/**
	 * @info - Starting an assessment, which is idempotent by design.
	 *
	 * The once-only rule is the unique index on `(user_id, lesson_id)`, not a
	 * read-then-write here: two Start presses racing each other must not open two
	 * sessions, so losing the race (23505) is treated as the other press having won
	 * and the caller just re-reads. `started_at` is never touched on a session that
	 * already exists — resuming must not restart the clock, because the clock ran
	 * while the student was away.
	 */
	startAssessment = async (authData: IAuthData, lessonId: number) => {
		/* @info - A draft lesson is the instructor's. Every student-facing entry
		 * point here names a lesson by id, so hiding unpublished rows from the
		 * module's lesson list would be a curtain with a door behind it. */
		await this.assertLessonVisible(authData, lessonId);
		const lesson = await this.assertAssessmentLesson(lessonId);
		const userId = Number(authData.id);
		await this.assertEnrolledInLesson(userId, lessonId);

		let session = await this.sessions.findByUserAndLesson(userId, lessonId);
		if (!session) {
			try {
				session = await this.sessions.create({
					userId,
					lessonId,
				} as any);
			} catch (e: any) {
				if (e?.code !== "23505") throw e;
				session = await this.sessions.findByUserAndLesson(userId, lessonId);
			}
		}

		return this.assessmentSessionResponse(userId, lesson, session ?? null);
	};

	/** @info - The read side: same body, never writes. The learn page calls this on
	 *  mount to choose between Start, Resume and a terminal state. */
	getAssessmentSession = async (authData: IAuthData, lessonId: number) => {
		/* @info - A draft lesson is the instructor's. Every student-facing entry
		 * point here names a lesson by id, so hiding unpublished rows from the
		 * module's lesson list would be a curtain with a door behind it. */
		await this.assertLessonVisible(authData, lessonId);
		const lesson = await this.assertAssessmentLesson(lessonId);
		const userId = Number(authData.id);
		await this.assertEnrolledInLesson(userId, lessonId);
		const session = await this.sessions.findByUserAndLesson(userId, lessonId);

		return this.assessmentSessionResponse(userId, lesson, session ?? null);
	};

	/**
	 * @info - The answer payload a resume needs. Deliberately no `isCorrect`: the
	 * autosave path writes these rows while the attempt is open, so echoing
	 * correctness here would turn the resume call into an answer oracle.
	 */
	listAttemptsForStudent = async (
		userId: number,
		lessonId: number,
	): Promise<Array<{ questionId: number; selectedAnswer: string | null }>> => {
		const rows = await this.attempts.findByUserAndLesson(userId, lessonId);

		return rows.map((row) => ({
			questionId: row.questionId,
			selectedAnswer: row.selectedAnswer,
		}));
	};

	/**
	 * @info - The shared assessment body. `serverNow` travels with it because the
	 * countdown is rendered from the server's clock offset by the client's — a
	 * client clock that is minutes out must not decide when the attempt ends.
	 */
	private assessmentSessionResponse = async (
		userId: number,
		lesson: { id: number; timeLimitMinutes: number | null },
		session: {
			startedAt: Date | null;
			submittedAt: Date | null;
		} | null,
	): Promise<{
		status: AssessmentStatus;
		startedAt: Date | null;
		deadline: Date | null;
		submittedAt: Date | null;
		serverNow: Date;
		timeLimitMinutes: number | null;
		answers: Array<{ questionId: number; selectedAnswer: string | null }>;
	}> => {
		const now = new Date();
		const timeLimitMinutes = lesson.timeLimitMinutes ?? null;
		const status = assessmentState({ session, timeLimitMinutes, now });

		return {
			status,
			startedAt: session?.startedAt ?? null,
			deadline: assessmentDeadline({
				startedAt: session?.startedAt ?? null,
				timeLimitMinutes,
			}),
			submittedAt: session?.submittedAt ?? null,
			serverNow: now,
			timeLimitMinutes,
			/* @info - Before Start there is nothing to resume, and returning the
			 * paper here would defeat D23's whole point. */
			answers:
				status === "not_started"
					? []
					: await this.listAttemptsForStudent(userId, lesson.id),
		};
	};

	/** @info - Every assessment endpoint resolves the lesson first: the type is what
	 *  decides whether these rules apply at all, and quizzes keep today's behaviour
	 *  untouched. */
	private assertAssessmentLesson = async (lessonId: number) => {
		const lesson = await this.lessons.findById(lessonId);
		if (!lesson) return throwNotFoundError(LessonMessages.NOT_FOUND);
		if (lesson.type !== "assessment") {
			return throwBadRequestError(QuizMessages.NOT_ASSESSMENT);
		}
		return lesson;
	};

	/**
	 * @info - Authorization. `requireInstructor` answers "is this person an
	 * instructor", never "is this their course", so every instructor route below
	 * resolves its resource back to a course and checks the owner first. Before
	 * these existed, any instructor could read another course's results and read,
	 * rewrite or delete another instructor's questions by guessing an id.
	 */
	private isOwnerOrAdmin = (
		course: { instructorId: number },
		authData?: IAuthData,
	): boolean => {
		const isOwner = Number(course.instructorId) === Number(authData?.id);
		const isAdmin =
			Array.isArray(authData?.roles) && authData.roles.includes("admin");
		return isOwner || isAdmin;
	};

	private assertCourseOwner = (
		course: { instructorId: number },
		authData?: IAuthData,
	) => {
		if (!this.isOwnerOrAdmin(course, authData)) {
			throwForbiddenError(QuizMessages.FORBIDDEN);
		}
	};

	/** @info - Resolves a course and asserts the caller may read or edit its
	 * quiz content. */
	private assertOwnedCourse = async (courseId: number, authData: IAuthData) => {
		const course = await this.courses.findById(Number(courseId));
		if (!course) throwNotFoundError(CourseMessages.NOT_FOUND);
		this.assertCourseOwner(course as any, authData);
		return course as any;
	};

	/** @info - Walks lesson → module → course, then asserts ownership there. */
	private assertOwnedLessonCourse = async (
		lessonId: number,
		authData: IAuthData,
	) => {
		const lesson = await this.lessons.findById(Number(lessonId));
		if (!lesson) return throwNotFoundError(LessonMessages.NOT_FOUND);
		const mod = await this.modules.findById(Number(lesson.moduleId));
		if (!mod || mod.courseId == null) {
			return throwNotFoundError(LessonMessages.NOT_FOUND);
		}
		await this.assertOwnedCourse(mod.courseId, authData);
		return lesson;
	};

	/** @info - Walks question → lesson → module → course, then asserts ownership
	 * there. Returns the resolved question so callers need not re-read it. */
	private assertOwnedQuestionCourse = async (
		questionId: number,
		authData: IAuthData,
	) => {
		const question = await this.questions.findById(Number(questionId));
		if (!question) return throwNotFoundError(QuizMessages.NOT_FOUND);
		await this.assertOwnedLessonCourse(question.lessonId, authData);
		return question;
	};

	/* Student: submit quiz */

	submit = async (
		authData: IAuthData,
		lessonId: number,
		submissions: QuizSubmission[],
	) => {
		await this.assertLessonVisible(authData, lessonId);
		/* @info - The attempt policy, checked before anything is written. */
		await this.assertAttemptOpen(authData, lessonId);

		const allQuestions = await this.questions.findByLesson(lessonId);

		if (allQuestions.length === 0) {
			throwBadRequestError(QuizMessages.NO_QUESTIONS);
		}

		const questionMap = new Map(allQuestions.map((q) => [q.id, q]));

		const results: Array<{
			questionId: number;
			selectedAnswer: string;
			correctAnswer: string;
			isCorrect: boolean;
			points: number;
			explanation: string | null;
		}> = [];

		let earnedPoints = 0;
		let totalPoints = 0;

		for (const sub of submissions) {
			const question = questionMap.get(sub.questionId);
			if (!question) continue;

			const isCorrect = sub.selectedAnswer === question.correctAnswer;
			const points = isCorrect ? question.points : 0;

			const existing = await this.attempts.findByUserAndQuestion(
				authData.id,
				sub.questionId,
			);

			if (existing) {
				await this.attempts.update(existing.id, {
					selectedAnswer: sub.selectedAnswer,
					isCorrect,
					attemptedAt: new Date(),
				} as any);
			} else {
				await this.attempts.create({
					userId: authData.id,
					lessonId,
					questionId: sub.questionId,
					selectedAnswer: sub.selectedAnswer,
					isCorrect,
				} as any);
			}

			earnedPoints += points;
			totalPoints += question.points;

			results.push({
				questionId: sub.questionId,
				selectedAnswer: sub.selectedAnswer,
				correctAnswer: question.correctAnswer,
				isCorrect,
				points,
				explanation: question.explanation,
			});
		}

		const score =
			totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 100) : 0;

		/* @info - Closing the attempt is part of a successful submit: the answers are
		 * graded above, so the session must stop accepting more of them. */
		await this.markAssessmentSubmitted(Number(authData.id), lessonId);

		return {
			total: allQuestions.length,
			submitted: submissions.length,
			correct: results.filter((r) => r.isCorrect).length,
			score,
			results,
		};
	};

	/* Student: view attempts */

	getAttempts = async (authData: IAuthData, lessonId: number) => {
		const rows = await this.attempts.findByUserAndLesson(authData.id, lessonId);
		const lesson = await this.assertLessonIfAssessment(lessonId);
		if (!lesson) return rows;

		/* @info - AC18. Autosave writes these rows DURING an open attempt, so
		 * returning `isCorrect` here makes the endpoint an answer oracle: autosave a
		 * guess, read back whether it was right, repeat. Withheld until the attempt
		 * is finished — `selectedAnswer` stays, because Resume rehydrates from it. */
		const userId = Number(authData.id);
		const session = await this.sessions.findByUserAndLesson(userId, lessonId);
		const status = assessmentState({
			session: session ?? null,
			timeLimitMinutes: lesson.timeLimitMinutes ?? null,
			now: new Date(),
		});
		if (status !== "in_progress") {
			/* @info - An expired attempt is graded here, on read (D9), because there is
			 * no background job to do it: this is the first moment anyone asks. */
			if (status === "expired") {
				await this.gradeExpiredAssessment(userId, lessonId);
				return this.attempts.findByUserAndLesson(userId, lessonId);
			}
			return rows;
		}

		return rows.map(({ isCorrect: _isCorrect, ...row }) => row);
	};

	/** @info - Student-facing questions: the answer key is stripped, and the
	 *  explanation is withheld only while it would be an oracle.
	 *
	 *  For an ASSESSMENT the paper is also unreadable before Start: `not_started`
	 *  is refused, so the questions cannot be read in advance of the attempt they
	 *  exist to measure (spec D23). Quizzes are untouched — no enrollment check is
	 *  retrofitted onto them (spec §10), so they stay readable exactly as today.
	 *
	 *  `explanation` is a different matter from the answer key. While an assessment
	 *  attempt is open it says why the right answer is right, which is the thing
	 *  being measured, so it stays hidden; once the attempt has closed it is the
	 *  most valuable sentence in the review, and withholding it forever meant a
	 *  student was told they were wrong with no way to learn why. A quiz reveals it
	 *  once the student has any attempt on record, which is when they have already
	 *  seen it in the submit response. */
	getLessonQuestions = async (authData: IAuthData, lessonId: number) => {
		/* @info - A draft lesson is the instructor's. Every student-facing entry
		 * point here names a lesson by id, so hiding unpublished rows from the
		 * module's lesson list would be a curtain with a door behind it. */
		await this.assertLessonVisible(authData, lessonId);
		const userId = Number(authData.id);
		const lesson = await this.assertLessonIfAssessment(lessonId);
		let revealExplanations = false;
		if (lesson) {
			await this.assertEnrolledInLesson(userId, lessonId);
			const session = await this.sessions.findByUserAndLesson(userId, lessonId);
			if (!session) {
				return throwForbiddenError(QuizMessages.ATTEMPT_NOT_STARTED);
			}
			const deadline = assessmentDeadline({
				startedAt: session.startedAt,
				timeLimitMinutes: lesson.timeLimitMinutes ?? null,
			});
			revealExplanations =
				session.submittedAt !== null ||
				(deadline !== null && new Date() > deadline);
		} else {
			const attempts = await this.attempts.findByUserAndLesson(userId, lessonId);
			revealExplanations = attempts.length > 0;
		}

		const questions = await this.questions.findByLesson(lessonId);
		return questions.map(({ correctAnswer: _, explanation, ...q }) => ({
			...q,
			explanation: revealExplanations ? explanation : null,
		}));
	};

	/* Instructor: aggregated quiz results per course */

	listByCourse = async (authData: IAuthData, courseId: number) => {
		await this.assertOwnedCourse(courseId, authData);
		const db = getDb();
		const rows = await db
			.select({
				userId: quizAttempts.userId,
				studentName: users.firstName,
				studentLastName: users.lastName,
				studentEmail: users.email,
				lessonId: quizAttempts.lessonId,
				lessonTitle: lessons.title,
				totalAttempted: sql<number>`count(${quizAttempts.id})`.mapWith(Number),
				correctCount:
					sql<number>`sum(case when ${quizAttempts.isCorrect} then 1 else 0 end)`.mapWith(
						Number,
					),
			})
			.from(quizAttempts)
			.innerJoin(users, eq(quizAttempts.userId, users.id))
			.innerJoin(lessons, eq(quizAttempts.lessonId, lessons.id))
			.innerJoin(modules, eq(lessons.moduleId, modules.id))
			/* @info - D25: an assessment appears here only once its session is closed
			 * (submitted, or past its deadline). Autosave writes these rows while the
			 * student is still answering, so without this the grading tab shows a run as
			 * finished — with a score — before it is. A LEFT join, so quizzes (which have
			 * no session rows at all) keep counting their attempts exactly as before. */
			.leftJoin(
				assessmentSessions,
				and(
					eq(assessmentSessions.lessonId, quizAttempts.lessonId),
					eq(assessmentSessions.userId, quizAttempts.userId),
				),
			)
			.where(
				and(
					eq(modules.courseId, courseId),
					sql`(
						${lessons.type} <> 'assessment'
						OR ${assessmentSessions.id} IS NULL
						OR ${assessmentSessions.submittedAt} IS NOT NULL
						OR (
							${lessons.timeLimitMinutes} IS NOT NULL
							AND now() > ${assessmentSessions.startedAt}
								+ (${lessons.timeLimitMinutes} * interval '1 minute')
						)
					)`,
				),
			)
			.groupBy(
				quizAttempts.userId,
				users.firstName,
				users.lastName,
				users.email,
				quizAttempts.lessonId,
				lessons.title,
			)
			.orderBy(users.firstName);

		return rows;
	};

	/* Instructor: Quiz Builder CRUD */

	listQuestions = async (authData: IAuthData, lessonId: number) => {
		await this.assertOwnedLessonCourse(lessonId, authData);
		return this.questions.findByLesson(lessonId);
	};

	createQuestion = async (authData: IAuthData, data: NewQuizQuestion) => {
		await this.assertOwnedLessonCourse(data.lessonId, authData);
		await this.assertQuestionsEditable(data.lessonId);
		const question = await this.questions.create(data as any);
		/* @info - Quiz content feeds the tutor; re-index the lesson */
		await this.reindexLesson(question!.lessonId);
		return question;
	};

	getQuestion = async (authData: IAuthData, id: number) => {
		return this.assertOwnedQuestionCourse(id, authData);
	};

	updateQuestion = async (
		authData: IAuthData,
		id: number,
		data: Partial<NewQuizQuestion>,
	) => {
		const owned = await this.assertOwnedQuestionCourse(id, authData);
		await this.assertQuestionsEditable(Number(owned?.lessonId));
		/* @info - Whitelist, the way `updateCourse` and `updateLesson` do it.
		 * `updateQuizQuestionSchema` omits `lessonId`, but that only constrains what
		 * Zod returns - the controller reads the raw body, so a smuggled `lessonId`
		 * still reaches the repository. The ownership assert above covers the lesson
		 * the question is LEAVING, so without this strip an instructor could relocate
		 * a question (and with it, arbitrary content) into a course they do not own.
		 * `id` is excluded for the same reason: it is a real column the update would
		 * otherwise happily write. */
		const editable: Partial<NewQuizQuestion> = {};
		for (const field of [
			"type",
			"text",
			"options",
			"correctAnswer",
			"explanation",
			"points",
			"sortOrder",
		] as const) {
			if (data[field] !== undefined) (editable as any)[field] = data[field];
		}

		const question = await this.questions.update(id, editable as any);
		if (question) await this.reindexLesson(question!.lessonId);
		return question ?? throwNotFoundError(QuizMessages.NOT_FOUND);
	};

	deleteQuestion = async (authData: IAuthData, id: number): Promise<void> => {
		const owned = await this.assertOwnedQuestionCourse(id, authData);
		await this.assertQuestionsEditable(Number(owned?.lessonId));
		const question = await this.questions.delete(id);
		if (!question) throwNotFoundError(QuizMessages.NOT_FOUND);
		await this.reindexLesson(question!.lessonId);
		this.log.info(`Quiz question ${id} deleted`);
	};

	/**
	 * @info - The question lock (D24/AC21). Adding, editing or deleting a question on
	 *         an assessment that has ANY session is refused, because every session's
	 *         score was computed against the question set as it stood: letting the
	 *         paper change afterwards moves a submitted student's grade, and with it
	 *         their leaderboard rank.
	 *
	 *         Called only by the three question mutations. `listQuestions`,
	 *         `getQuestion` and the reset endpoint stay open — reading the paper and
	 *         clearing the sessions are how an instructor gets out of the lock.
	 *
	 *         A quiz lesson is never locked: quizzes have no sessions and no
	 *         once-only rule, which is why this checks the lesson type first.
	 */
	private assertQuestionsEditable = async (lessonId: number) => {
		const lesson = await this.assertLessonIfAssessment(lessonId);
		if (!lesson) return;

		const sessions = await this.sessions.findByLesson(lessonId);
		if (sessions.length > 0) {
			return throwConflictError(QuizMessages.ASSESSMENT_LOCKED);
		}
	};

	/**
	 * @info - Resetting one student's attempt: it is what makes the lock liftable.
	 *         Deleting the session alone would leave their autosaved answers behind,
	 *         and the next Start would hand them back a pre-filled paper — the bug
	 *         this exists to prevent, so both go.
	 */
	resetAssessmentAttempt = async (
		authData: IAuthData,
		lessonId: number,
		userId: number,
	) => {
		const lesson = await this.assertAssessmentLesson(lessonId);
		await this.assertOwnedLessonCourse(lesson.id, authData);

		const session = await this.sessions.findByUserAndLesson(userId, lessonId);
		if (session) await this.sessions.delete(session.id);
		for (const row of await this.attempts.findByUserAndLesson(
			userId,
			lessonId,
		)) {
			await this.attempts.delete(row.id);
		}

		this.log.info(`Assessment attempt reset`, { lessonId, userId });
		return { reset: true };
	};

	/** @info - Re-embed the lesson after quiz edits (best-effort, published only) */
	private async reindexLesson(lessonId: number) {
		try {
			const { enqueueLessonForIndexing } = await import(
				"@/services/queues/lesson-chunk.queue.service"
			);
			await enqueueLessonForIndexing(lessonId);
		} catch (e) {
			this.log.error(`Quiz reindex failed for lesson ${lessonId}`, e);
		}
	}
}
