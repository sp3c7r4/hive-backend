/**
 * @info - AI grading assist module service. Human-in-the-loop boundary:
 * the AI only ever writes staging fields; this service owns approval
 * (the sole path from suggestion to a student-visible grade), batch
 * orchestration, review listing, and the instructor ownership guard.
 */
import { and, eq, gt, isNull, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/postgres.db";
import { config } from "@/config";
import { logger } from "@/utils";
import {
	throwBadRequestError,
	throwForbiddenError,
	throwNotFoundError,
} from "@/helpers/errors/throw-errors";
import { EmailQueueService } from "@/services";
import { EmailJobNames } from "@/enums";
import { GradingService } from "@/services/ai/grading.service";
import { GradingQueueService } from "@/services/queues/grading.queue.service";
import { GradingPubSubService } from "@/services/engine/grading-pubsub.service";
import {
	assignmentSubmissions,
} from "@/modules/assessments/assessment.model";
import { lessons, modules, courses } from "@/modules/courses/course.model";
import { users } from "@/modules/user/user.model";
import { aiGradingLogs, gradingBatches } from "./ai-grading.model";

export const suggestGradeSchema = z.object({
	submissionId: z.number().int().positive(),
	instructorContext: z.string().max(2000).optional(),
});

export const massGradeSchema = z.object({
	submissionIds: z.array(z.number().int().positive()).min(1).max(200),
	instructorContext: z.string().max(2000).optional(),
	regrade: z.boolean().optional(),
});

export const approveSuggestionSchema = z.object({
	score: z.number().int().min(0).max(100).optional(),
	feedback: z.string().optional(),
	edited: z.boolean().optional(),
});

/** @info - Unreviewed = suggestion newer than the last official grade */
export const reviewFilter = and(
	sql`${assignmentSubmissions.aiSuggestedAt} IS NOT NULL`,
	or(
		isNull(assignmentSubmissions.gradedAt),
		gt(assignmentSubmissions.aiSuggestedAt, assignmentSubmissions.gradedAt),
	),
);

export class AiGradingService {
	private static instance: AiGradingService;
	private readonly log = logger;
	private readonly grading = GradingService.getInstance();
	private readonly queue = GradingQueueService.getInstance();
	private readonly emailQueue = EmailQueueService.getInstance();

	static getInstance(): AiGradingService {
		if (!this.instance) this.instance = new AiGradingService();
		return this.instance;
	}

	/** @info - Instructor owns the course this lesson belongs to */
	private assertLessonOwner = async (instructorId: number, lessonId: number) => {
		const db = getDb();
		const [row] = await db
			.select({ courseId: modules.courseId, instructorId: courses.instructorId })
			.from(lessons)
			.innerJoin(modules, eq(lessons.moduleId, modules.id))
			.innerJoin(courses, eq(modules.courseId, courses.id))
			.where(eq(lessons.id, lessonId))
			.limit(1);
		if (!row) throwNotFoundError("Lesson not found");
		if (row!.instructorId !== instructorId) {
			throwForbiddenError("You can only grade submissions in your own courses.");
		}
		return row!.courseId;
	};

	private assertCourseOwner = async (instructorId: number, courseId: number) => {
		const db = getDb();
		const [row] = await db
			.select({ instructorId: courses.instructorId })
			.from(courses)
			.where(eq(courses.id, courseId))
			.limit(1);
		if (!row) throwNotFoundError("Course not found");
		if (row!.instructorId !== instructorId) {
			throwForbiddenError("You can only review submissions in your own courses.");
		}
	};

	/** @info - Single suggestion. Suggestion only; approval is separate. */
	suggest = async (
		instructorId: number,
		body: z.infer<typeof suggestGradeSchema>,
	) => {
		const db = getDb();
		const [submission] = await db
			.select()
			.from(assignmentSubmissions)
			.where(eq(assignmentSubmissions.id, body.submissionId))
			.limit(1);
		if (!submission) throwNotFoundError("Submission not found");
		if (!submission!.text) throwBadRequestError("This submission has no text to grade.");

		await this.assertLessonOwner(instructorId, submission!.lessonId);

		const suggestion = await this.grading.gradeSubmission(submission!.id, {
			instructorContext: body.instructorContext,
		});
		return suggestion;
	};

	/** @info - Mass grading: validate, skip already-graded unless regrade,
	 * create the batch row (source of truth) and enqueue one job each. */
	massGrade = async (
		instructorId: number,
		body: z.infer<typeof massGradeSchema>,
	) => {
		const db = getDb();
		const rows = await db
			.select()
			.from(assignmentSubmissions)
			.where(inArray(assignmentSubmissions.id, body.submissionIds));
		if (rows.length === 0) throwBadRequestError("No submissions selected.");

		const lessonIds = new Set(rows.map((r) => r.lessonId));
		if (lessonIds.size > 1) {
			throwBadRequestError("All submissions must belong to one lesson.");
		}
		const lessonId = rows[0]!.lessonId;
		await this.assertLessonOwner(instructorId, lessonId);

		const eligible = body.regrade
			? rows
			: rows.filter(
					(r) =>
						r.status !== "graded" &&
						r.status !== "returned" &&
						r.aiSuggestedAt === null,
				);
		if (eligible.length === 0) {
			throwBadRequestError("Nothing to grade: every selection is already graded.");
		}

		const [batch] = await db
			.insert(gradingBatches)
			.values({
				lessonId,
				createdBy: instructorId,
				totalCount: eligible.length,
				instructorContext: body.instructorContext ?? null,
			})
			.returning();

		for (const s of eligible) {
			await this.queue.enqueueGrade({
				submissionId: s.id,
				batchId: batch!.id,
				instructorContext: body.instructorContext,
			});
		}

		return { batch: batch!, skipped: rows.length - eligible.length };
	};

	/** @info - Batch snapshot (drawer opens/reopens from this, never from
	 * the stream). Includes the per-submission rows from the audit log. */
	batchSnapshot = async (instructorId: number, batchId: number) => {
		const db = getDb();
		const [batch] = await db
			.select()
			.from(gradingBatches)
			.where(eq(gradingBatches.id, batchId))
			.limit(1);
		if (!batch) throwNotFoundError("Batch not found");
		await this.assertLessonOwner(instructorId, batch!.lessonId);

		const entries = await db
			.select({
				submissionId: aiGradingLogs.submissionId,
				status: aiGradingLogs.status,
				score: aiGradingLogs.suggestedScore,
				studentName: users.firstName,
				studentLastName: users.lastName,
			})
			.from(aiGradingLogs)
			.innerJoin(
				assignmentSubmissions,
				eq(aiGradingLogs.submissionId, assignmentSubmissions.id),
			)
			.innerJoin(users, eq(assignmentSubmissions.userId, users.id))
			.where(eq(aiGradingLogs.batchId, batchId));

		return { batch, entries };
	};

	/** @info - Review queue: unreviewed suggestions for a course (2.3 filter) */
	reviewList = async (instructorId: number, courseId: number) => {
		await this.assertCourseOwner(instructorId, courseId);
		const db = getDb();
		return db
			.select({
				id: assignmentSubmissions.id,
				lessonId: assignmentSubmissions.lessonId,
				lessonTitle: lessons.title,
				studentName: users.firstName,
				studentLastName: users.lastName,
				studentEmail: users.email,
				text: assignmentSubmissions.text,
				status: assignmentSubmissions.status,
				aiSuggestedScore: assignmentSubmissions.aiSuggestedScore,
				aiSuggestedFeedback: assignmentSubmissions.aiSuggestedFeedback,
				aiSuggestedAt: assignmentSubmissions.aiSuggestedAt,
				score: assignmentSubmissions.score,
				gradedAt: assignmentSubmissions.gradedAt,
			})
			.from(assignmentSubmissions)
			.innerJoin(lessons, eq(assignmentSubmissions.lessonId, lessons.id))
			.innerJoin(modules, eq(lessons.moduleId, modules.id))
			.innerJoin(users, eq(assignmentSubmissions.userId, users.id))
			.where(and(eq(modules.courseId, courseId), reviewFilter))
			.orderBy(assignmentSubmissions.aiSuggestedAt);
	};

	/** @info - Approve a suggestion (optionally edited): the ONLY path from
	 * an AI suggestion to an official, student-visible grade. Marks the
	 * audit row approved-edited vs unedited and queues the graded email. */
	approve = async (
		instructorId: number,
		submissionId: number,
		body: z.infer<typeof approveSuggestionSchema>,
	) => {
		const db = getDb();
		const [submission] = await db
			.select()
			.from(assignmentSubmissions)
			.where(eq(assignmentSubmissions.id, submissionId))
			.limit(1);
		if (!submission) throwNotFoundError("Submission not found");
		if (submission!.aiSuggestedAt === null) {
			throwBadRequestError("No AI suggestion to approve on this submission.");
		}
		await this.assertLessonOwner(instructorId, submission!.lessonId);

		const score = body.score ?? submission!.aiSuggestedScore ?? 0;
		const feedback = body.feedback ?? submission!.aiSuggestedFeedback ?? null;
		const edited = body.edited ?? false;

		await db
			.update(assignmentSubmissions)
			.set({
				score,
				feedback,
				status: "graded",
				gradedAt: new Date(),
			})
			.where(eq(assignmentSubmissions.id, submissionId));

		await db
			.update(aiGradingLogs)
			.set({ approvedEdited: edited ? "edited" : "unedited" })
			.where(eq(aiGradingLogs.id, submission!.aiGraderRunId!));

		/* Queue the same graded email the manual path sends */
		const [student] = await db
			.select({ email: users.email, firstName: users.firstName })
			.from(users)
			.where(eq(users.id, submission!.userId))
			.limit(1);
		const [lessonRow] = await db
			.select({ title: lessons.title, settings: lessons.settings })
			.from(lessons)
			.where(eq(lessons.id, submission!.lessonId))
			.limit(1);
		const maxScore =
			(lessonRow?.settings as { maxScore?: number } | null)?.maxScore ?? 100;

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
					score,
					maxScore,
					feedback: feedback ?? "",
					dashboardUrl: `${config.server.rootDomain}/dashboard`,
				},
			});
		}

		return { id: submissionId, score, feedback, status: "graded" };
	};

	/** @info - Decline a suggestion: clears the staging fields so the
	 * submission leaves the review queue without becoming a grade. The audit
	 * row is marked declined so the trust signal stays intact. */
	decline = async (instructorId: number, submissionId: number) => {
		const db = getDb();
		const [submission] = await db
			.select()
			.from(assignmentSubmissions)
			.where(eq(assignmentSubmissions.id, submissionId))
			.limit(1);
		if (!submission) throwNotFoundError("Submission not found");
		await this.assertLessonOwner(instructorId, submission!.lessonId);

		await db
			.update(assignmentSubmissions)
			.set({
				aiSuggestedScore: null,
				aiSuggestedFeedback: null,
				aiSuggestedAt: null,
				aiGraderRunId: null,
			})
			.where(eq(assignmentSubmissions.id, submissionId));

		if (submission!.aiGraderRunId) {
			await db
				.update(aiGradingLogs)
				.set({ approvedEdited: "declined" })
				.where(eq(aiGradingLogs.id, submission!.aiGraderRunId));
		}

		return { id: submissionId, status: submission!.status };
	};

	/** @info - Regenerate a suggestion for one submission (fresh run, new
	 * audit row, replaces the staged suggestion). */
	regenerate = async (instructorId: number, submissionId: number) => {
		const db = getDb();
		const [submission] = await db
			.select()
			.from(assignmentSubmissions)
			.where(eq(assignmentSubmissions.id, submissionId))
			.limit(1);
		if (!submission) throwNotFoundError("Submission not found");
		if (!submission!.text) {
			throwBadRequestError("This submission has no text to grade.");
		}
		await this.assertLessonOwner(instructorId, submission!.lessonId);

		return this.grading.gradeSubmission(submissionId);
	};

	/** @info - SSE ownership check reused by the stream route */
	assertBatchOwner = async (instructorId: number, batchId: number) => {
		const db = getDb();
		const [batch] = await db
			.select()
			.from(gradingBatches)
			.where(eq(gradingBatches.id, batchId))
			.limit(1);
		if (!batch) throwNotFoundError("Batch not found");
		await this.assertLessonOwner(instructorId, batch!.lessonId);
		return batch!;
	};
}
