import { RelationalRepository } from "@/bases";
import { quizQuestions, quizAttempts } from "./assessment.model";
import { eq, and } from "drizzle-orm";

export class QuizQuestionRepository extends RelationalRepository<typeof quizQuestions> {
	private static instance: QuizQuestionRepository | null;

	static getInstance(): QuizQuestionRepository {
		if (!this.instance) this.instance = new QuizQuestionRepository();
		return this.instance;
	}

	private constructor() {
		super(quizQuestions);
	}

	findByLesson = async (lessonId: number) => {
		return this.findMany(eq(quizQuestions.lessonId, lessonId));
	};
}

export class QuizAttemptRepository extends RelationalRepository<typeof quizAttempts> {
	private static instance: QuizAttemptRepository | null;

	static getInstance(): QuizAttemptRepository {
		if (!this.instance) this.instance = new QuizAttemptRepository();
		return this.instance;
	}

	private constructor() {
		super(quizAttempts);
	}

	findByUserAndLesson = async (userId: number, lessonId: number) => {
		return this.findMany(
			and(
				eq(quizAttempts.userId, userId),
				eq(quizAttempts.lessonId, lessonId),
			) as any,
		);
	};

	findByUserAndQuestion = async (userId: number, questionId: number) => {
		return this.findOne(
			and(
				eq(quizAttempts.userId, userId),
				eq(quizAttempts.questionId, questionId),
			) as any,
		);
	};
}
