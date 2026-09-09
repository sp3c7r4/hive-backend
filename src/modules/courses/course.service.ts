import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { RelationalRepository } from "@/bases";
import { getDb } from "@/db/postgres.db";
import { LessonType, UserRole } from "@/enums";
import { withPresignedUrl, withTransaction } from "@/helpers";
import {
	throwBadRequestError,
	throwForbiddenError,
	throwNotFoundError,
} from "@/helpers/errors/throw-errors";
import { isGoogleDriveLink } from "@/helpers/google-drive.helper";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { communities } from "@/modules/communities/community.model";
import { enrollments } from "@/modules/enrollments/enrollment.model";
import { users } from "@/modules/user/user.model";
import { user_roles } from "@/modules/user/user-role.model";
import { MeetingSchedulerService } from "@/services/meeting-scheduler.service";
import { PaginationService } from "@/services/pagination.service";
import { serviceLogger } from "@/utils";
import {
	CourseMessages,
	LessonMessages,
	ModuleMessages,
} from "./course.message";
import type { NewCourse, NewLesson, NewModule } from "./course.model";
import { courses, lessons, modules } from "./course.model";
import {
	CourseRepository,
	LessonRepository,
	ModuleRepository,
} from "./course.repository";

/* @info - The HTTP layer sends scheduledAt as an ISO string (zod is only
 * used as a 400 gate in this codebase - controllers re-read raw bodies).
 * Drizzle timestamp columns need a Date, so coerce at the service edge. */
const normalizeScheduledAt = <T extends { scheduledAt?: unknown }>(
	data: T,
): T => {
	if (typeof data.scheduledAt === "string") {
		return { ...data, scheduledAt: new Date(data.scheduledAt) } as T;
	}
	return data;
};

export class CourseService {
	private static instance: CourseService;
	private coursesRepo: CourseRepository;
	private modulesRepo: ModuleRepository;
	private lessonsRepo: LessonRepository;

	/** @info - Services */
	private paginationService: PaginationService<typeof courses>;

	/** @info - Utilities */
	private readonly log = serviceLogger("Course");

	static getInstance(): CourseService {
		if (!this.instance) this.instance = new CourseService();
		return this.instance;
	}

	private constructor() {
		this.coursesRepo = CourseRepository.getInstance();
		this.modulesRepo = ModuleRepository.getInstance();
		this.lessonsRepo = LessonRepository.getInstance();
		this.paginationService = new PaginationService(courses);
	}

	/* Courses */

	/** @info - Any course mutation requires the owning instructor or a
	 * platform admin (mirrors community.service assertOwnerOrAdmin). */
	private assertCourseOwner = (
		course: { instructorId: number },
		authData?: IAuthData,
	) => {
		const isOwner = Number(course.instructorId) === Number(authData?.id);
		const isAdmin =
			Array.isArray(authData?.roles) &&
			(authData as any).roles.includes("admin");
		if (!isOwner && !isAdmin) {
			throwForbiddenError("You don't have permission to modify this course.");
		}
	};

	/** @info - Resolves a course and asserts the caller may mutate it. */
	private assertOwnedCourse = async (courseId: number, authData: IAuthData) => {
		const course = await this.coursesRepo.findById(Number(courseId));
		if (!course) throwNotFoundError(CourseMessages.NOT_FOUND);
		this.assertCourseOwner(course as any, authData);
		return course as any;
	};

	/** @info - Resolves a module's owning course and asserts the caller may
	 * mutate anything under it. */
	private assertOwnedModuleCourse = async (
		mod: { courseId: number | null },
		authData: IAuthData,
	) => {
		const courseId = mod.courseId;
		if (courseId == null) throwNotFoundError(ModuleMessages.NOT_FOUND);
		return this.assertOwnedCourse(courseId as number, authData);
	};

	createCourse = async (authData: IAuthData, data: NewCourse) => {
		const db = getDb();
		const slug = await this._uniqueCourseSlug(data.title, authData.id);

		return withTransaction(async (tx) => {
			const courseRepo = new RelationalRepository(courses, tx);
			const course = await courseRepo.create({
				...data,
				slug,
				instructorId: authData.id,
			} as any);

			// Bump community course count
			await tx
				.update(communities)
				.set({ courseCount: sql`${communities.courseCount} + 1` })
				.where(eq(communities.id, data.communityId!));

			return course;
		});
	};

	getCourse = async (idOrSlug: number | string) => {
		const db = getDb();
		const isNumericId =
			typeof idOrSlug === "number" || /^\d+$/.test(String(idOrSlug));

		let course: any = null;
		if (isNumericId) {
			const [result] = await db
				.select()
				.from(courses)
				.where(and(eq(courses.id, Number(idOrSlug)), isNull(courses.deletedAt)))
				.limit(1);
			course = result ?? null;
		} else {
			const [result] = await db
				.select()
				.from(courses)
				.where(
					and(eq(courses.slug, String(idOrSlug)), isNull(courses.deletedAt)),
				)
				.limit(1);
			course = result ?? null;
		}

		if (!course) throwNotFoundError(CourseMessages.NOT_FOUND);

		/* @info - Include the community so the UI can label + gate private
		 * courses without a second lookup */
		const enriched = { ...course } as Record<string, unknown>;
		/* @info - Instructor profile for the detail page (name + avatar) */
		const [instructorUser] = await db
			.select({
				firstName: users.firstName,
				lastName: users.lastName,
				avatarUrl: users.avatarUrl,
			})
			.from(users)
			.where(eq(users.id, course!.instructorId))
			.limit(1);
		enriched.instructor = instructorUser
			? {
					id: course!.instructorId,
					name: `${instructorUser.firstName ?? ""} ${instructorUser.lastName ?? ""}`.trim(),
					avatarUrl: instructorUser.avatarUrl
						? withPresignedUrl(
								{ avatar: instructorUser.avatarUrl } as any,
								"avatar",
							).avatar
						: null,
				}
			: null;
		if (course!.communityId != null) {
			const [comm] = await db
				.select({ name: communities.name, slug: communities.slug })
				.from(communities)
				.where(eq(communities.id, course!.communityId))
				.limit(1);
			enriched.communityName = comm?.name ?? null;
			enriched.communitySlug = comm?.slug ?? null;
		}
		return withPresignedUrl(enriched, "coverImageUrl");
	};

	listCourses = async (params?: {
		page?: number;
		limit?: number;
		communityId?: number;
		includeDrafts?: boolean;
		authData?: IAuthData | null;
	}) => {
		const conditions: any[] = [isNull(courses.deletedAt)];

		/* @info - Drafts are visible ONLY to the community owner/platform admin
		 * inside a community-scoped listing (their community Courses tab).
		 * Everyone else (and every unscoped/Explore listing) sees published
		 * courses only. */
		let showUnpublished = false;
		if (params?.includeDrafts && params?.communityId && params?.authData) {
			const [communityRow] = await getDb()
				.select({ ownerId: communities.ownerId })
				.from(communities)
				.where(eq(communities.id, params.communityId))
				.limit(1);
			showUnpublished =
				!!communityRow &&
				(communityRow.ownerId === params.authData.id ||
					params.authData.roles?.includes(UserRole.ADMIN));
		}
		if (!showUnpublished) {
			conditions.push(eq(courses.status, "published"));
		}

		if (params?.communityId) {
			conditions.push(eq(courses.communityId, params.communityId));
		} else {
			// Only show public courses in Explore / general listing
			conditions.push(eq(courses.visibility, "public"));
		}

		const result = await this.paginationService.paginate({
			page: params?.page ?? 1,
			limit: params?.limit ?? 20,
			where: and(...conditions),
		});

		return {
			...result,
			data: result.data.map((c) => withPresignedUrl(c, "coverImageUrl")),
		};
	};

	/** @info Returns courses the authenticated user is enrolled in */
	/** @info - Returns courses for the authenticated user:
	 *          instructor → courses they created; student → courses they enrolled in */
	listMine = async (authData: IAuthData) => {
		const db = getDb();

		const selectFields = {
			id: courses.id,
			instructorId: courses.instructorId,
			communityId: courses.communityId,
			title: courses.title,
			slug: courses.slug,
			subtitle: courses.subtitle,
			description: courses.description,
			category: courses.category,
			difficulty: courses.difficulty,
			visibility: courses.visibility,
			price: courses.price,
			isFree: courses.isFree,
			monthlyPrice: courses.monthlyPrice,
			coverImageUrl: courses.coverImageUrl,
			sequentialAccess: courses.sequentialAccess,
			dripContent: courses.dripContent,
			allowComments: courses.allowComments,
			allowDownloads: courses.allowDownloads,
			offerCertificate: courses.offerCertificate,
			minCompletionPercent: courses.minCompletionPercent,
			minQuizScorePercent: courses.minQuizScorePercent,
			status: courses.status,
			enrollmentCount: courses.enrollmentCount,
			deletedAt: courses.deletedAt,
			createdAt: courses.createdAt,
			updatedAt: courses.updatedAt,
		};

		/* Roles may be missing OR stale-empty from authData (e.g. after OAuth
		 * signup the session cached roles: [] before the user picked a role) —
		 * query DB whenever the cache cannot prove an instructor */
		let roles = authData.roles as string[] | undefined;
		if (!Array.isArray(roles) || roles.length === 0) {
			const roleRows = await db
				.select({ role: user_roles.role })
				.from(user_roles)
				.where(eq(user_roles.userId, authData.id));
			roles = roleRows.map((r) => r.role);
		}
		const isInstructor = roles.includes(UserRole.INSTRUCTOR);

		let rows: any[];
		if (isInstructor) {
			/* Instructor: courses they created */
			rows = await db
				.select(selectFields)
				.from(courses)
				.where(
					and(eq(courses.instructorId, authData.id), isNull(courses.deletedAt)),
				)
				.orderBy(desc(courses.updatedAt));
		} else {
			/* Student: enrolled courses */
			rows = await db
				.select(selectFields)
				.from(courses)
				.innerJoin(enrollments, eq(courses.id, enrollments.courseId))
				.where(
					and(eq(enrollments.userId, authData.id), isNull(courses.deletedAt)),
				)
				.orderBy(desc(courses.updatedAt));
		}

		return rows.map((c: any) => withPresignedUrl(c, "coverImageUrl"));
	};

	updateCourse = async (
		authData: IAuthData,
		id: number,
		data: Partial<NewCourse>,
	) => {
		const course = await this.coursesRepo.findById(id);
		if (!course) throwNotFoundError(CourseMessages.NOT_FOUND);
		this.assertCourseOwner(course as any, authData);

		// Coerce FormData string values to proper types
		const coerced: Record<string, any> = { ...data };
		if (typeof coerced.price === "string")
			coerced.price = Number(coerced.price);
		if (typeof coerced.isFree === "string")
			coerced.isFree = coerced.isFree === "true";
		if (typeof coerced.sequentialAccess === "string")
			coerced.sequentialAccess = coerced.sequentialAccess === "true";
		if (typeof coerced.dripContent === "string")
			coerced.dripContent = coerced.dripContent === "true";
		if (typeof coerced.allowComments === "string")
			coerced.allowComments = coerced.allowComments === "true";
		if (typeof coerced.allowDownloads === "string")
			coerced.allowDownloads = coerced.allowDownloads === "true";
		if (typeof coerced.offerCertificate === "string")
			coerced.offerCertificate = coerced.offerCertificate === "true";
		if (typeof coerced.minCompletionPercent === "string")
			coerced.minCompletionPercent = Number(coerced.minCompletionPercent);
		if (typeof coerced.minQuizScorePercent === "string")
			coerced.minQuizScorePercent = Number(coerced.minQuizScorePercent);
		if (typeof coerced.minAttendancePercent === "string")
			coerced.minAttendancePercent = Number(coerced.minAttendancePercent);
		if (typeof coerced.monthlyPrice === "string")
			coerced.monthlyPrice =
				coerced.monthlyPrice === "" ? null : Number(coerced.monthlyPrice);
		if (coerced.price === "") coerced.price = 0;

		const updated = await this.coursesRepo.update(id, coerced as any);
		if (!updated) throwNotFoundError(CourseMessages.NOT_FOUND);

		return withPresignedUrl(updated!, "coverImageUrl");
	};

	deleteCourse = async (authData: IAuthData, id: number): Promise<void> => {
		// Fetch first to get communityId before soft-delete hides it
		const course = await this.coursesRepo.findById(id);
		if (!course) throwNotFoundError(CourseMessages.NOT_FOUND);
		this.assertCourseOwner(course as any, authData);

		await this.coursesRepo.softDelete(id);

		// Decrement community course count (floor at 0)
		const db = getDb();
		await db
			.update(communities)
			.set({ courseCount: sql`GREATEST(${communities.courseCount} - 1, 0)` })
			.where(eq(communities.id, course!.communityId));

		this.log.info(`Course ${id} soft-deleted`);
	};

	private _slugify = (title: string, instructorId: number): string => {
		const base = title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "");
		const suffix = instructorId.toString(36).slice(-4);
		return `${base}-${suffix}`;
	};

	private _uniqueCourseSlug = async (
		title: string,
		instructorId: number,
	): Promise<string> => {
		const base = this._slugify(title, instructorId);

		/* Check if slug already exists */
		const db = getDb();
		const [existing] = await db
			.select({ id: courses.id })
			.from(courses)
			.where(eq(courses.slug, base))
			.limit(1);
		if (!existing) return base;

		/* Collision — append a random 4-char suffix until unique */
		for (let i = 0; i < 5; i++) {
			const rand = Math.random().toString(36).slice(2, 6);
			const candidate = `${base}-${rand}`;
			const [dup] = await db
				.select({ id: courses.id })
				.from(courses)
				.where(eq(courses.slug, candidate))
				.limit(1);
			if (!dup) return candidate;
		}

		/* Extremely unlikely — fallback to timestamp */
		return `${base}-${Date.now().toString(36)}`;
	};

	/* Modules */

	createModule = async (
		authData: IAuthData,
		courseId: number,
		data: NewModule,
	) => {
		await this.assertOwnedCourse(courseId, authData);
		return this.modulesRepo.create({ ...data, courseId } as any);
	};

	listModules = async (courseId: number) => {
		const db = getDb();
		return db
			.select()
			.from(modules)
			.where(eq(modules.courseId, courseId))
			.orderBy(asc(modules.sortOrder));
	};

	updateModule = async (
		authData: IAuthData,
		id: number,
		data: Partial<NewModule>,
	) => {
		const mod = await this.modulesRepo.findById(id);
		if (!mod) throwNotFoundError(ModuleMessages.NOT_FOUND);
		await this.assertOwnedModuleCourse(mod as any, authData);
		const updated = await this.modulesRepo.update(id, data as any);
		return updated ?? throwNotFoundError(ModuleMessages.NOT_FOUND);
	};

	deleteModule = async (authData: IAuthData, id: number): Promise<void> => {
		const mod = await this.modulesRepo.findById(id);
		if (!mod) throwNotFoundError(ModuleMessages.NOT_FOUND);
		await this.assertOwnedModuleCourse(mod as any, authData);
		const deleted = await this.modulesRepo.softDelete(id);
		if (!deleted) throwNotFoundError(ModuleMessages.NOT_FOUND);
		this.log.info(`Module ${id} soft-deleted`);
	};

	/* Lessons */

	/**
	 * @info - A google_drive lesson may be created as a draft without its link
	 * (the two-step add-lesson flow). Only an INVALID link is rejected; a
	 * missing link is fine and gets filled in from the editor drawer.
	 */
	private assertDriveLink(
		type: string | undefined,
		driveUrl: string | null | undefined,
	) {
		if (
			type === LessonType.GOOGLE_DRIVE &&
			driveUrl &&
			!isGoogleDriveLink(driveUrl)
		) {
			throwBadRequestError(
				"A valid Google Drive share link is required for Google Drive lessons.",
			);
		}
	}

	createLesson = async (
		authData: IAuthData,
		moduleId: number,
		data: NewLesson,
	) => {
		const mod = await this.modulesRepo.findById(moduleId);
		if (!mod) throwNotFoundError(ModuleMessages.NOT_FOUND);
		await this.assertOwnedModuleCourse(mod as any, authData);
		this.assertDriveLink(data.type, data.driveUrl);
		const lesson = await this.lessonsRepo.create({
			...normalizeScheduledAt(data),
			moduleId,
		} as any);
		/* @info - Publish immediately? Index it for the AI tutor */
		if (lesson.status === "published") {
			const { enqueueLessonForIndexing } = await import(
				"@/services/queues/lesson-chunk.queue.service"
			);
			await enqueueLessonForIndexing(lesson.id);
		}
		return lesson;
	};

	listLessons = async (moduleId: number) => {
		const db = getDb();
		return db
			.select()
			.from(lessons)
			.where(eq(lessons.moduleId, moduleId))
			.orderBy(asc(lessons.sortOrder), asc(lessons.id));
	};

	updateLesson = async (
		authData: IAuthData,
		id: number,
		data: Partial<NewLesson>,
	) => {
		const db = getDb();
		const [existing] = await db
			.select()
			.from(lessons)
			.where(eq(lessons.id, id))
			.limit(1);
		if (!existing) throwNotFoundError(LessonMessages.NOT_FOUND);
		const mod = await this.modulesRepo.findById(Number(existing!.moduleId));
		if (!mod) throwNotFoundError(ModuleMessages.NOT_FOUND);
		await this.assertOwnedModuleCourse(mod as any, authData);
		data = normalizeScheduledAt(data);
		/* @info - validate the merged state so clearing a link is impossible without changing type */
		this.assertDriveLink(
			data.type ?? existing!.type,
			data.driveUrl ?? existing!.driveUrl,
		);
		/* @info - Re-arming: editing the time of an ended session brings it
		 * back to the calendar (ended sessions are hidden by design, which
		 * made reschedules look like they 'didn't commit'). */
		if (
			data.scheduledAt &&
			existing!.liveStatus === "ended" &&
			existing!.meetingType &&
			existing!.meetingType !== "none"
		) {
			data = { ...data, liveStatus: "scheduled" };
		}
		const lesson = await this.lessonsRepo.update(id, data as any);
		/* @info - A published lesson that was edited gets re-embedded so the
		 * tutor never serves stale content */
		const merged = { ...existing, ...data };
		if (lesson && merged.status === "published") {
			const { enqueueLessonForIndexing } = await import(
				"@/services/queues/lesson-chunk.queue.service"
			);
			await enqueueLessonForIndexing(id);
		}
		return lesson ?? throwNotFoundError(LessonMessages.NOT_FOUND);
	};

	deleteLesson = async (authData: IAuthData, id: number): Promise<void> => {
		const lesson = await this.lessonsRepo.findById(id);
		if (!lesson) throwNotFoundError(LessonMessages.NOT_FOUND);
		const mod = await this.modulesRepo.findById(
			Number((lesson as any).moduleId),
		);
		if (!mod) throwNotFoundError(ModuleMessages.NOT_FOUND);
		await this.assertOwnedModuleCourse(mod as any, authData);
		const deleted = await this.lessonsRepo.softDelete(id);
		if (!deleted) throwNotFoundError(LessonMessages.NOT_FOUND);
		this.log.info(`Lesson ${id} soft-deleted`);
	};

	/* Live Class Meeting Generation */

	generateMeeting = async (
		authData: IAuthData,
		lessonId: number,
		options: {
			provider: "google" | "zoom";
			summary: string;
			description?: string;
			startTime: string;
			endTime: string;
			attendees?: Array<{ entityId: number; entityType: string }>;
			duration?: number;
			autoRecord?: boolean;
		},
	) => {
		const lesson = await this.lessonsRepo.findById(lessonId);
		if (!lesson) throwNotFoundError(LessonMessages.NOT_FOUND);
		const mod = await this.modulesRepo.findById(
			Number((lesson as any).moduleId),
		);
		if (!mod) throwNotFoundError(ModuleMessages.NOT_FOUND);
		await this.assertOwnedModuleCourse(mod as any, authData);

		const scheduler = MeetingSchedulerService.getInstance();

		const result = await scheduler.scheduleMeeting({
			provider: options.provider,
			summary: options.summary,
			description: options.description,
			startTime: options.startTime,
			endTime: options.endTime,
			attendees: options.attendees?.map((a) => `${a.entityType}:${a.entityId}`),
			duration: options.duration,
			autoRecord: options.autoRecord,
		});

		/* Store the meeting link on the lesson */
		await this.lessonsRepo.update(lessonId, {
			liveMeetingLink: result.joinLink,
			liveMeetingDate: options.startTime,
		} as any);

		return result;
	};
}
