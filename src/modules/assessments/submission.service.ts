import { and, eq } from "drizzle-orm";
import { config } from "@/config";
import { getDb } from "@/db/postgres.db";
import { EmailJobNames } from "@/enums";
import {
	throwForbiddenError,
	throwNotFoundError,
} from "@/helpers/errors/throw-errors";
import { withPresignedUrl } from "@/helpers/storage.helper";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { LessonMessages } from "@/modules/courses/course.message";
import { lessons, modules } from "@/modules/courses/course.model";
import { assertLessonVisibleTo } from "@/modules/courses/lesson-visibility";
import {
	CourseRepository,
	LessonRepository,
	ModuleRepository,
} from "@/modules/courses/course.repository";
import { users } from "@/modules/user/user.model";
import { EmailQueueService } from "@/services/queues/email.queue.service";
import { serviceLogger } from "@/utils";
import { assignmentSubmissions } from "./assessment.model";
import { SubmissionMessages } from "./submission.message";
import { AssignmentSubmissionRepository } from "./submission.repository";

export class AssignmentService {
	private static instance: AssignmentService;
	private submissions: AssignmentSubmissionRepository;
	private lessons: LessonRepository;
	private courses: CourseRepository;
	private modules: ModuleRepository;
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
		this.courses = CourseRepository.getInstance();
		this.modules = ModuleRepository.getInstance();
	}

	/**
	 * @info - Authorization. `requireInstructor` answers "is this person an
	 * instructor", never "is this their course" or "is this their own work", so
	 * every route below resolves its resource back to a course and checks the
	 * caller first. Before these existed any instructor could read any course's
	 * submissions, grade any submission on the platform and rewrite any
	 * assignment's settings, and `GET /submissions/:id` - which carried no guard
	 * beyond a valid token - handed any logged-in user another student's work,
	 * its score and the instructor's written feedback.
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
			throwForbiddenError(SubmissionMessages.FORBIDDEN);
		}
	};

	/** @info - Resolves a course and asserts the caller may read or edit its
	 * assignment content. */
	private assertOwnedCourse = async (courseId: number, authData: IAuthData) => {
		const course = await this.courses.findById(Number(courseId));
		if (!course) return throwNotFoundError(SubmissionMessages.COURSE_NOT_FOUND);
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

	/** @info - Walks submission → lesson → module → course, then asserts
	 * ownership there. Returns the resolved submission so callers need not read it
	 * twice. */
	private assertOwnedSubmissionCourse = async (
		submissionId: number,
		authData: IAuthData,
	) => {
		const submission = await this.submissions.findById(Number(submissionId));
		if (!submission) return throwNotFoundError(SubmissionMessages.NOT_FOUND);
		await this.assertOwnedLessonCourse(submission.lessonId, authData);
		return submission;
	};

	/**
	 * @info - Read gate for a single submission: its own author, or the instructor
	 * who owns the lesson's course. The route is documented as Instructor/Student,
	 * so tightened owner-only would break a student fetching their own work.
	 */
	private assertCanReadSubmission = async (
		submission: { userId: number; lessonId: number },
		authData: IAuthData,
	) => {
		if (Number(submission.userId) === Number(authData.id)) return;
		await this.assertOwnedLessonCourse(submission.lessonId, authData);
	};

	/* Student: Submit an assignment */

	submit = async (
		authData: IAuthData,
		lessonId: number,
		text: string | undefined,
		fileUrls: string[],
	) => {
		/* @info - A module that has not opened refuses writes, not just reads. Without
		 * this the submission and its uploaded files landed in the database while the
		 * lesson itself still answered 403, so the student was told no and got a row. */
		await assertLessonVisibleTo(authData, lessonId);
		// Upsert: replace existing submission
		const existing = await this.submissions.findByUserAndLesson(
			authData.id,
			lessonId,
		);
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
		authData: IAuthData,
		courseId: number,
		params?: { page?: number; limit?: number; status?: string },
	) => {
		await this.assertOwnedCourse(courseId, authData);
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
				aiSuggestedScore: assignmentSubmissions.aiSuggestedScore,
				aiSuggestedAt: assignmentSubmissions.aiSuggestedAt,
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

	/* Instructor/Student: Get single submission */

	get = async (authData: IAuthData, id: number) => {
		const submission = await this.submissions.findById(id);
		if (!submission) return throwNotFoundError(SubmissionMessages.NOT_FOUND);
		await this.assertCanReadSubmission(submission as any, authData);
		return withPresignedUrl(submission as any, "fileUrls");
	};

	/* Instructor: Grade a submission */

	grade = async (
		authData: IAuthData,
		id: number,
		body: {
			score: number;
			feedback?: string;
			action: "grade" | "return_for_revision";
		},
	) => {
		await this.assertOwnedSubmissionCourse(id, authData);
		const submission = await this.submissions.findById(id);
		if (!submission) return throwNotFoundError(SubmissionMessages.NOT_FOUND);

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
		authData: IAuthData,
		lessonId: number,
		settings: {
			instructions?: string;
			dueDate?: string;
			maxScore?: number;
			submissionType?: string;
			rubric?: Record<string, any>;
		},
	) => {
		await this.assertOwnedLessonCourse(lessonId, authData);

		const updated = await this.lessons.update(lessonId, {
			settings,
		} as any);

		return updated;
	};
}
