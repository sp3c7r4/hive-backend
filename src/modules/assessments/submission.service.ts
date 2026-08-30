import { eq, and } from "drizzle-orm";
import { throwNotFoundError, throwBadRequestError } from "@/helpers/errors/throw-errors";
import { serviceLogger } from "@/utils";
import { config } from "@/config";
import { getDb } from "@/db/postgres.db";
import { withPresignedUrl } from "@/helpers/storage.helper";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { EmailJobNames } from "@/enums";
import { EmailQueueService } from "@/services/queues/email.queue.service";
import { SubmissionMessages } from "./submission.message";
import { assignmentSubmissions } from "./assessment.model";
import { AssignmentSubmissionRepository } from "./submission.repository";
import { LessonRepository } from "@/modules/courses/course.repository";
import { users } from "@/modules/user/user.model";
import { lessons, modules } from "@/modules/courses/course.model";

export class AssignmentService {
	private static instance: AssignmentService;
	private submissions: AssignmentSubmissionRepository;
	private lessons: LessonRepository;
	private readonly emailQueue = EmailQueueService.getInstance();

	/** @info - Utilities */
	private readonly log = serviceLogger("Assignment");

	static getInstance(): AssignmentService {
		if (!this.instance) this.instance = new AssignmentService();
		return this.instance;
	}

	private constructor() {
		this.submissions = AssignmentSubmissionRepository.getInstance();
		this.lessons = LessonRepository.getInstance();
	}

	/* Student: Submit an assignment */

	submit = async (
		authData: IAuthData,
		lessonId: number,
		text: string | undefined,
		fileUrls: string[],
	) => {
		// Upsert: replace existing submission
		const existing = await this.submissions.findByUserAndLesson(authData.id, lessonId);
		if (existing) {
			return this.submissions.update(existing.id, {
				text: text ?? null,
				fileUrls,
				status: "submitted",
				submittedAt: new Date(),
				score: null,
				feedback: null,
				gradedAt: null,
			} as any);
		}
		return this.submissions.create({
			userId: authData.id,
			lessonId,
			text: text ?? null,
			fileUrls,
			status: "submitted",
			submittedAt: new Date(),
		} as any);
	};

	/* Student: Get my submission for a lesson */

	getByUserAndLesson = async (userId: number, lessonId: number) => {
		const sub = await this.submissions.findByUserAndLesson(userId, lessonId);
		return sub ? withPresignedUrl(sub as any, "fileUrls") : null;
	};

	/* Instructor: List submissions for a course's assignment lessons */

	listByCourse = async (
		courseId: number,
		params?: { page?: number; limit?: number; status?: string },
	) => {
		const db = getDb();
		const conditions: any[] = [eq(modules.courseId, courseId)];

		if (params?.status) {
			conditions.push(eq(assignmentSubmissions.status as any, params.status));
		}

		const where = conditions.length === 1 ? conditions[0] : and(...conditions);

		// Join submissions → lessons → modules, include user name + lesson title
		const query = db
			.select({
				id: assignmentSubmissions.id,
				userId: assignmentSubmissions.userId,
				studentName: users.firstName,
				studentLastName: users.lastName,
				studentEmail: users.email,
				lessonId: assignmentSubmissions.lessonId,
				lessonTitle: lessons.title,
				text: assignmentSubmissions.text,
				fileUrls: assignmentSubmissions.fileUrls,
				status: assignmentSubmissions.status,
				score: assignmentSubmissions.score,
				feedback: assignmentSubmissions.feedback,
				submittedAt: assignmentSubmissions.submittedAt,
				gradedAt: assignmentSubmissions.gradedAt,
			})
			.from(assignmentSubmissions)
			.innerJoin(lessons, eq(assignmentSubmissions.lessonId, lessons.id))
			.innerJoin(modules, eq(lessons.moduleId, modules.id))
			.innerJoin(users, eq(assignmentSubmissions.userId, users.id))
			.where(where)
			.orderBy(assignmentSubmissions.submittedAt);

		// Manual pagination
		const page = params?.page ?? 1;
		const limit = params?.limit ?? 20;
		const offset = (page - 1) * limit;

		const [countRows, rows] = await Promise.all([
			db
				.select({ count: assignmentSubmissions.id })
				.from(assignmentSubmissions)
				.innerJoin(lessons, eq(assignmentSubmissions.lessonId, lessons.id))
				.innerJoin(modules, eq(lessons.moduleId, modules.id))
				.where(where),
			query.limit(limit).offset(offset),
		]);

		return {
			data: rows.map((r: any) => withPresignedUrl(r, "fileUrls")),
			meta: {
				total: countRows.length,
				page,
				limit,
				totalPages: Math.ceil(countRows.length / limit),
			},
		};
	};

	/* Instructor: Get single submission */

	get = async (id: number) => {
		const submission = await this.submissions.findById(id);
		if (!submission) throwNotFoundError(SubmissionMessages.NOT_FOUND);
		return withPresignedUrl(submission as any, "fileUrls");
	};

	/* Instructor: Grade a submission */

	grade = async (
		id: number,
		body: { score: number; feedback?: string; action: "grade" | "return_for_revision" },
	) => {
		const submission = await this.submissions.findById(id);
		if (!submission) throwNotFoundError(SubmissionMessages.NOT_FOUND);

		const status = body.action === "grade" ? "graded" : "returned";

		const updated = await this.submissions.update(id, {
			score: body.score,
			feedback: body.feedback ?? null,
			status,
			gradedAt: body.action === "grade" ? new Date() : null,
		} as any);

		this.log.info(`Submission ${id} ${body.action}d`, {
			score: body.score,
		});

		/* Queue assignment-graded email when grading */
		if (body.action === "grade") {
			const db = getDb();
			const [student] = await db
				.select({ email: users.email, firstName: users.firstName })
				.from(users)
				.where(eq(users.id, submission!.userId))
				.limit(1);
			const [lessonRow] = await db
				.select({ title: lessons.title })
				.from(lessons)
				.where(eq(lessons.id, submission!.lessonId))
				.limit(1);

			if (student?.email) {
				this.emailQueue.add(EmailJobNames.ASSIGNMENT_GRADED as any, {
					message: {
						to: student.email,
						subject: `Your assignment has been graded: ${lessonRow?.title ?? "submission"}`,
					},
					template: "assignment-graded" as any,
					locals: {
						studentName: student.firstName ?? "there",
						lessonName: lessonRow?.title ?? "your submission",
						score: body.score,
						maxScore: (submission as any).maxScore ?? 100,
						feedback: body.feedback ?? "",
						dashboardUrl: `${config.server.rootDomain}/dashboard`,
					},
				});
			}
		}

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
