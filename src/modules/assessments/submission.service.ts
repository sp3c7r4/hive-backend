import { eq } from "drizzle-orm";
import { throwNotFoundError, throwBadRequestError } from "@/helpers/errors/throw-errors";
import { PaginationService } from "@/services/pagination.service";
import { serviceLogger } from "@/utils";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { SubmissionMessages } from "./submission.message";
import { assignmentSubmissions } from "./assessment.model";
import { AssignmentSubmissionRepository } from "./submission.repository";
import { LessonRepository } from "@/modules/courses/course.repository";

export class AssignmentService {
	private static instance: AssignmentService;
	private submissions: AssignmentSubmissionRepository;
	private lessons: LessonRepository;

	/** @info - Services */
	private paginationService: PaginationService<typeof assignmentSubmissions>;

	/** @info - Utilities */
	private readonly log = serviceLogger("Assignment");

	static getInstance(): AssignmentService {
		if (!this.instance) this.instance = new AssignmentService();
		return this.instance;
	}

	private constructor() {
		this.submissions = AssignmentSubmissionRepository.getInstance();
		this.lessons = LessonRepository.getInstance();
		this.paginationService = new PaginationService(assignmentSubmissions);
	}

	/* Instructor: List submissions for a course's assignment lessons */

	listByCourse = async (
		courseId: number,
		params?: { page?: number; limit?: number; status?: string },
	) => {
		const conditions: any[] = [];

		if (params?.status) {
			conditions.push(
				eq(assignmentSubmissions.status as any, params.status),
			);
		}

		return this.paginationService.paginate({
			page: params?.page ?? 1,
			limit: params?.limit ?? 20,
			where: conditions.length ? conditions[0] : undefined,
		});
	};

	/* Instructor: Get single submission */

	get = async (id: number) => {
		const submission = await this.submissions.findById(id);
		return submission ?? throwNotFoundError(SubmissionMessages.NOT_FOUND);
	};

	/* Instructor: Grade a submission */

	grade = async (
		id: number,
		body: { score: number; feedback?: string; action: "grade" | "return_for_revision" },
	) => {
		const submission = await this.submissions.findById(id);
		if (!submission) throwNotFoundError(SubmissionMessages.NOT_FOUND);

		const status = body.action === "grade" ? "graded" : "pending";

		const updated = await this.submissions.update(id, {
			score: body.score,
			feedback: body.feedback ?? null,
			status,
			gradedAt: body.action === "grade" ? new Date() : null,
		} as any);

		this.log.info(`Submission ${id} ${body.action}d`, {
			score: body.score,
		});

		return updated;
	};

	/* Instructor: Update assignment settings on a lesson */

	updateAssignmentSettings = async (
		lessonId: number,
		settings: {
			instructions?: string;
			dueDate?: string;
			maxScore?: number;
			submissionType?: string;
			rubric?: Record<string, any>;
		},
	) => {
		const lesson = await this.lessons.findById(lessonId);
		if (!lesson) throwNotFoundError("Lesson not found");

		const updated = await this.lessons.update(lessonId, {
			settings,
		} as any);

		return updated;
	};
}
