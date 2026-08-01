import { QuizQuestionRepository, QuizAttemptRepository } from "./quiz.repository";

interface QuizSubmission {
	questionId: number;
	selectedAnswer: string;
}

export class QuizService {
	private static instance: QuizService;

	private readonly questions: QuizQuestionRepository;
	private readonly attempts: QuizAttemptRepository;

	static getInstance(): QuizService {
		if (!this.instance) this.instance = new QuizService();
		return this.instance;
	}

	private constructor() {
		this.questions = QuizQuestionRepository.getInstance();
		this.attempts = QuizAttemptRepository.getInstance();
	}

	/**
	 * @info - Submit answers for a quiz lesson and auto-grade.
	 * Returns { total, correct, score, results[] }.
	 */
	submit = async (
		userId: number,
		lessonId: number,
		submissions: QuizSubmission[],
	) => {
		const allQuestions = await this.questions.findByLesson(lessonId);
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

			/** @info - Upsert: update if exists, create if new */
			const existing = await this.attempts.findByUserAndQuestion(
				userId,
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
					userId,
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

		const score = totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 100) : 0;

		return {
			total: allQuestions.length,
			submitted: submissions.length,
			correct: results.filter((r) => r.isCorrect).length,
			score,
			results,
		};
	};

	getAttempts = async (userId: number, lessonId: number) => {
		return this.attempts.findByUserAndLesson(userId, lessonId);
	};
}
