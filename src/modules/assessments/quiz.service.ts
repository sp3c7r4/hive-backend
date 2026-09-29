import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import {
	throwBadRequestError,
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
import { users } from "@/modules/user/user.model";
import { serviceLogger } from "@/utils";
import type { NewQuizQuestion } from "./assessment.model";
import { quizAttempts } from "./assessment.model";
import { QuizMessages } from "./quiz.message";
import {
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
	private courses: CourseRepository;
	private modules: ModuleRepository;
	private lessons: LessonRepository;

	/** @info - Utilities */
	private readonly log = serviceLogger("Quiz");

	static getInstance(): QuizService {
		if (!this.instance) this.instance = new QuizService();
		return this.instance;
	}

	private constructor() {
		this.questions = QuizQuestionRepository.getInstance();
		this.attempts = QuizAttemptRepository.getInstance();
		this.courses = CourseRepository.getInstance();
		this.modules = ModuleRepository.getInstance();
		this.lessons = LessonRepository.getInstance();
	}

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
		return this.attempts.findByUserAndLesson(authData.id, lessonId);
	};

	/** @info - Student-facing quiz questions: answers & explanations stripped */
	getLessonQuestions = async (lessonId: number) => {
		const questions = await this.questions.findByLesson(lessonId);
		return questions.map(({ correctAnswer: _, explanation: __, ...q }) => q);
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
			.where(eq(modules.courseId, courseId))
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
		await this.assertOwnedQuestionCourse(id, authData);
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
		await this.assertOwnedQuestionCourse(id, authData);
		const question = await this.questions.delete(id);
		if (!question) throwNotFoundError(QuizMessages.NOT_FOUND);
		await this.reindexLesson(question!.lessonId);
		this.log.info(`Quiz question ${id} deleted`);
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
