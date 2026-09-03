import { throwBadRequestError, throwNotFoundError } from "@/helpers/errors/throw-errors";
import { serviceLogger } from "@/utils";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { QuizMessages } from "./quiz.message";
import { QuizQuestionRepository, QuizAttemptRepository } from "./quiz.repository";
import type { NewQuizQuestion } from "./assessment.model";
import { getDb } from "@/db/postgres.db";
import { quizAttempts } from "./assessment.model";
import { users } from "@/modules/user/user.model";
import { lessons, modules } from "@/modules/courses/course.model";
import { eq, and, sql } from "drizzle-orm";

interface QuizSubmission {
	questionId: number;
	selectedAnswer: string;
}

export class QuizService {
	private static instance: QuizService;
	private questions: QuizQuestionRepository;
	private attempts: QuizAttemptRepository;

	/** @info - Utilities */
	private readonly log = serviceLogger("Quiz");

	static getInstance(): QuizService {
		if (!this.instance) this.instance = new QuizService();
		return this.instance;
	}

	private constructor() {
		this.questions = QuizQuestionRepository.getInstance();
		this.attempts = QuizAttemptRepository.getInstance();
	}

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

		const score = totalPoints > 0
			? Math.round((earnedPoints / totalPoints) * 100)
			: 0;

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

	listByCourse = async (courseId: number) => {
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
				correctCount: sql<number>`sum(case when ${quizAttempts.isCorrect} then 1 else 0 end)`.mapWith(Number),
			})
			.from(quizAttempts)
			.innerJoin(users, eq(quizAttempts.userId, users.id))
			.innerJoin(lessons, eq(quizAttempts.lessonId, lessons.id))
			.innerJoin(modules, eq(lessons.moduleId, modules.id))
			.where(eq(modules.courseId, courseId))
			.groupBy(quizAttempts.userId, users.firstName, users.lastName, users.email, quizAttempts.lessonId, lessons.title)
			.orderBy(users.firstName);

		return rows;
	};

	/* Instructor: Quiz Builder CRUD */

	listQuestions = async (lessonId: number) => {
		return this.questions.findByLesson(lessonId);
	};

	createQuestion = async (data: NewQuizQuestion) => {
		const question = await this.questions.create(data as any);
		/* @info - Quiz content feeds the tutor; re-index the lesson */
		await this.reindexLesson(question!.lessonId);
		return question;
	};

	getQuestion = async (id: number) => {
		const question = await this.questions.findById(id);
		return question ?? throwNotFoundError(QuizMessages.NOT_FOUND);
	};

	updateQuestion = async (id: number, data: Partial<NewQuizQuestion>) => {
		const question = await this.questions.update(id, data as any);
		if (question) await this.reindexLesson(question!.lessonId);
		return question ?? throwNotFoundError(QuizMessages.NOT_FOUND);
	};

	deleteQuestion = async (id: number): Promise<void> => {
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
