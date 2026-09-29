import { and, eq } from "drizzle-orm";
import { RelationalRepository } from "@/bases";
import {
	assessmentSessions,
	quizAttempts,
	quizQuestions,
} from "./assessment.model";

export class QuizQuestionRepository extends RelationalRepository<
	typeof quizQuestions
> {
	private static instance: QuizQuestionRepository;

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

export class QuizAttemptRepository extends RelationalRepository<
	typeof quizAttempts
> {
	private static instance: QuizAttemptRepository;

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

/**
 * @info - One row per student per assessment lesson, and the once-only rule.
 *         `create` relies on `uq_assessment_session` rather than a read-then-write:
 *         two concurrent Start presses must not open two sessions, and only the
 *         database can promise that, so a duplicate-key error here is the expected
 *         way the race is lost and the caller re-reads instead.
 */
export class AssessmentSessionRepository extends RelationalRepository<
	typeof assessmentSessions
> {
	private static instance: AssessmentSessionRepository;

	static getInstance(): AssessmentSessionRepository {
		if (!this.instance) this.instance = new AssessmentSessionRepository();
		return this.instance;
	}

	private constructor() {
		super(assessmentSessions);
	}

	findByUserAndLesson = async (userId: number, lessonId: number) => {
		return this.findOne(
			and(
				eq(assessmentSessions.userId, userId),
				eq(assessmentSessions.lessonId, lessonId),
			) as any,
		);
	};

	findByLesson = async (lessonId: number) => {
		return this.findMany(eq(assessmentSessions.lessonId, lessonId));
	};
}
