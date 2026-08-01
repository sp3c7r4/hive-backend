import { throwBadRequestError } from "@/helpers/errors/throw-errors";
import { serviceLogger } from "@/utils";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { QuizMessages } from "./quiz.message";
import { QuizQuestionRepository, QuizAttemptRepository } from "./quiz.repository";

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
		}> = [];

		let earnedPoints = 0;
		let totalPoints = 0;

		for (const sub of submissions) {
			const question = questionMap.get(sub.questionId);
			if (!question) continue;

			const isCorrect = sub.selectedAnswer === question.correctAnswer;
			const points = isCorrect ? question.points : 0;

			/* Upsert: update if exists, create if new */
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

	getAttempts = async (authData: IAuthData, lessonId: number) => {
		return this.attempts.findByUserAndLesson(authData.id, lessonId);
	};
}
