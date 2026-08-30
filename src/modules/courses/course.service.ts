import { MeetingSchedulerService } from "@/services/meeting-scheduler.service";
import { eq, and, isNull, asc, desc, sql } from "drizzle-orm";
import { throwNotFoundError } from "@/helpers/errors/throw-errors";
import { PaginationService } from "@/services/pagination.service";
import { serviceLogger } from "@/utils";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { UserRole } from "@/enums";
import { CourseMessages, ModuleMessages, LessonMessages } from "./course.message";
import { courses, modules, lessons } from "./course.model";
import { communities } from "@/modules/communities/community.model";
import { enrollments } from "@/modules/enrollments/enrollment.model";
import { user_roles } from "@/modules/user/user-role.model";
import {
	CourseRepository,
	ModuleRepository,
	LessonRepository,
} from "./course.repository";
import type { NewCourse, NewModule, NewLesson } from "./course.model";
import { getDb } from "@/db/postgres.db";
import { withPresignedUrl, withTransaction } from "@/helpers";
import { RelationalRepository } from "@/bases";

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
		const isNumericId = typeof idOrSlug === "number" || /^\d+$/.test(String(idOrSlug));

		let course;
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
				.where(and(eq(courses.slug, String(idOrSlug)), isNull(courses.deletedAt)))
				.limit(1);
			course = result ?? null;
		}

		if (!course) throwNotFoundError(CourseMessages.NOT_FOUND);
		return withPresignedUrl(course!, "coverImageUrl");
	};

	listCourses = async (params?: { page?: number; limit?: number; communityId?: number }) => {
		const conditions: any[] = [isNull(courses.deletedAt)];

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

		return { ...result, data: result.data.map(c => withPresignedUrl(c, "coverImageUrl")) };
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

		/* Roles may be missing from authData (e.g. after token refresh rebuild) — query DB to be safe */
		let roles = authData.roles as string[] | undefined;
		if (!Array.isArray(roles)) {
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
				.where(and(
					eq(courses.instructorId, authData.id),
					isNull(courses.deletedAt),
				))
				.orderBy(desc(courses.updatedAt));
		} else {
			/* Student: enrolled courses */
			rows = await db
				.select(selectFields)
				.from(courses)
				.innerJoin(enrollments, eq(courses.id, enrollments.courseId))
				.where(and(
					eq(enrollments.userId, authData.id),
					isNull(courses.deletedAt),
				))
				.orderBy(desc(courses.updatedAt));
		}

		return rows.map((c: any) => withPresignedUrl(c, "coverImageUrl"));
	};

	updateCourse = async (authData: IAuthData, id: number, data: Partial<NewCourse>) => {
		const course = await this.coursesRepo.findById(id);
		if (!course) throwNotFoundError(CourseMessages.NOT_FOUND);

		// Coerce FormData string values to proper types
		const coerced: Record<string, any> = { ...data };
		if (typeof coerced.price === "string") coerced.price = Number(coerced.price);
		if (typeof coerced.isFree === "string") coerced.isFree = coerced.isFree === "true";
		if (typeof coerced.sequentialAccess === "string") coerced.sequentialAccess = coerced.sequentialAccess === "true";
		if (typeof coerced.dripContent === "string") coerced.dripContent = coerced.dripContent === "true";
		if (typeof coerced.allowComments === "string") coerced.allowComments = coerced.allowComments === "true";
		if (typeof coerced.allowDownloads === "string") coerced.allowDownloads = coerced.allowDownloads === "true";
		if (typeof coerced.offerCertificate === "string") coerced.offerCertificate = coerced.offerCertificate === "true";
		if (typeof coerced.minCompletionPercent === "string") coerced.minCompletionPercent = Number(coerced.minCompletionPercent);
		if (typeof coerced.minQuizScorePercent === "string") coerced.minQuizScorePercent = Number(coerced.minQuizScorePercent);
		if (typeof coerced.minAttendancePercent === "string") coerced.minAttendancePercent = Number(coerced.minAttendancePercent);
		if (typeof coerced.monthlyPrice === "string") coerced.monthlyPrice = coerced.monthlyPrice === "" ? null : Number(coerced.monthlyPrice);
		if (coerced.price === "") coerced.price = 0;

		const updated = await this.coursesRepo.update(id, coerced as any);
		if (!updated) throwNotFoundError(CourseMessages.NOT_FOUND);

		return withPresignedUrl(updated!, "coverImageUrl");
	};

	deleteCourse = async (id: number): Promise<void> => {
		// Fetch first to get communityId before soft-delete hides it
		const course = await this.coursesRepo.findById(id);
		if (!course) throwNotFoundError(CourseMessages.NOT_FOUND);

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

	createModule = async (courseId: number, data: NewModule) => {
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

	updateModule = async (id: number, data: Partial<NewModule>) => {
		const mod = await this.modulesRepo.update(id, data as any);
		return mod ?? throwNotFoundError(ModuleMessages.NOT_FOUND);
	};

	deleteModule = async (id: number): Promise<void> => {
		const mod = await this.modulesRepo.softDelete(id);
		if (!mod) throwNotFoundError(ModuleMessages.NOT_FOUND);
		this.log.info(`Module ${id} soft-deleted`);
	};

	/* Lessons */

	createLesson = async (moduleId: number, data: NewLesson) => {
		return this.lessonsRepo.create({ ...data, moduleId } as any);
	};

	listLessons = async (moduleId: number) => {
		const db = getDb();
		return db
			.select()
			.from(lessons)
			.where(eq(lessons.moduleId, moduleId))
			.orderBy(asc(lessons.sortOrder), asc(lessons.id));
	};

	updateLesson = async (id: number, data: Partial<NewLesson>) => {
		const lesson = await this.lessonsRepo.update(id, data as any);
		return lesson ?? throwNotFoundError(LessonMessages.NOT_FOUND);
	};

	deleteLesson = async (id: number): Promise<void> => {
		const lesson = await this.lessonsRepo.softDelete(id);
		if (!lesson) throwNotFoundError(LessonMessages.NOT_FOUND);
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
