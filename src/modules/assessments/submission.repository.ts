import { RelationalRepository } from "@/bases";
import { assignmentSubmissions } from "./assessment.model";
import { eq, and } from "drizzle-orm";

export class AssignmentSubmissionRepository extends RelationalRepository<
	typeof assignmentSubmissions
> {
	private static instance: AssignmentSubmissionRepository;

	static getInstance(): AssignmentSubmissionRepository {
		if (!this.instance) this.instance = new AssignmentSubmissionRepository();
		return this.instance;
	}

	private constructor() {
		super(assignmentSubmissions);
	}

	findByLesson = async (lessonId: number) => {
		return this.findMany(
			eq(assignmentSubmissions.lessonId, lessonId),
		);
	};

	findByUserAndLesson = async (userId: number, lessonId: number) => {
		return this.findOne(
			and(eq(assignmentSubmissions.userId, userId), eq(assignmentSubmissions.lessonId, lessonId)) as any,
		);
	};
}
