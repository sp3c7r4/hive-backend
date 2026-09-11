import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { RelationalRepository } from "@/bases";
import { getDb } from "@/db/postgres.db";
import { LessonMeetingType, LessonType, UserRole } from "@/enums";
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
import {
	decorateLessonsWithSessions,
	type LessonMeetingInput,
	LiveSessionService,
	toLiveSessionFields,
} from "@/modules/live";
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
import { createCourseFormSchema, updateCourseSchema } from "./course.schema";

/* @info - A lesson save carries meeting fields that are stored on the lesson's
 * live session, not on the lesson (migration 0028 dropped the lessons columns), so
 * they are split off before the lesson insert/update. scheduledAt arrives as an ISO
 * string and needs a Date. */
const splitLessonMeeting = <T extends Record<string, any>>(
	data: T,
): {
	lessonData: Omit<T, keyof LessonMeetingInput>;
	meeting: LessonMeetingInput;
} => {
	const {
		meetingType,
		meetingUrl,
		scheduledAt,
		durationMinutes,
		...lessonData
	} = data;
	return {
		lessonData: lessonData as Omit<T, keyof LessonMeetingInput>,
		meeting: {
			meetingType,
			meetingUrl,
			scheduledAt:
				typeof scheduledAt === "string"
					? new Date(scheduledAt)
					: (scheduledAt ?? undefined),
			durationMinutes,
		},
	};
};

/** @info - Provider meeting times arrive as strings; an unparseable one is ignored. */
const parseMeetingDate = (value?: string): Date | undefined => {
	if (!value) return undefined;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

export class CourseService {
	private static instance: CourseService;
	private coursesRepo: CourseRepository;
	private modulesRepo: ModuleRepository;
	private lessonsRepo: LessonRepository;

	/** @info - Services */
	private paginationService: PaginationService<typeof courses>;
	private liveSessions = LiveSessionService.getInstance();

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
	private isOwnerOrAdmin = (
		course: { instructorId: number },
		authData?: IAuthData,
	): boolean => {
		const isOwner = Number(course.instructorId) === Number(authData?.id);
		const isAdmin =
			Array.isArray(authData?.roles) &&
			(authData as any).roles.includes("admin");
		return isOwner || isAdmin;
	};

	private assertCourseOwner = (
		course: { instructorId: number },
		authData?: IAuthData,
	) => {
		if (!this.isOwnerOrAdmin(course, authData)) {
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

	/** @info - Is the requester enrolled in this course? */
	private _isEnrolled = async (courseId: number, userId: number) => {
		const db = getDb();
		const [enr] = await db
			.select({ id: enrollments.id })
			.from(enrollments)
			.where(
				and(eq(enrollments.courseId, courseId), eq(enrollments.userId, userId)),
			)
			.limit(1);
		return !!enr;
	};

	/** @info - Read-gate predicate: published OR enrolled OR owner/admin. */
	private _canReadCourse = async (
		course: { id: number; instructorId: number; status: string },
		authData?: IAuthData,
	): Promise<boolean> => {
		if (course.status === "published") return true;
		const isOwner = Number(course.instructorId) === Number(authData?.id);
		const isAdmin =
			Array.isArray(authData?.roles) &&
			(authData as any).roles.includes("admin");
		if (isOwner || isAdmin) return true;
		if (authData?.id) {
			return this._isEnrolled(course.id, Number(authData.id));
		}
		return false;
	};

	createCourse = async (authData: IAuthData, data: NewCourse) => {
		/* @info - Allowlist: createCourseFormSchema is the create contract. The
		 * controller used to spread the raw form into the insert, so any key
		 * matching a column name (status, instructorId, enrollmentCount, …) was
		 * written — the same mass-assignment class the PATCH allowlist closed.
		 * instructorId and slug are assigned here, never taken from the payload. */
		const parsed = createCourseFormSchema.safeParse(data);
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			throwBadRequestError(issue?.message ?? "Invalid course payload.");
		}
		const allowed = parsed.data as Record<string, any>;
		const slug = await this._uniqueCourseSlug(allowed.title, authData.id);

		return withTransaction(async (tx) => {
			const courseRepo = new RelationalRepository(courses, tx);
			const course = await courseRepo.create({
				...allowed,
				slug,
				instructorId: authData.id,
			} as any);

			// Bump community course count
			await tx
				.update(communities)
				.set({ courseCount: sql`${communities.courseCount} + 1` })
				.where(eq(communities.id, allowed.communityId!));

			return course;
		});
	};

	getCourse = async (idOrSlug: number | string, authData?: IAuthData) => {
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

		/* @info - Read gate: content is visible only to published courses,
		 * enrolled students, the owning instructor, or admins. Everyone else
		 * (authenticated strangers) gets a landing payload without content. */
		const canRead = await this._canReadCourse(course, authData);

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
		const instructor = instructorUser
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

		if (!canRead) {
			/* @info - Landing payload: hero fields only. No description, price,
			 * status, community, or enrollment data leaks to strangers. */
			return withPresignedUrl(
				{
					id: course!.id,
					title: course!.title,
					subtitle: course!.subtitle ?? null,
					coverImageUrl: course!.coverImageUrl ?? null,
					instructor,
					access: "landing",
				},
				"coverImageUrl",
			);
		}

		/* @info - Full payload (published OR enrolled OR owner/admin). Include
		 * the community so the UI can label + gate private courses. */
		const enriched = {
			...course,
			instructor,
			access: "full",
		} as Record<string, unknown>;
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
	}) => {
		const conditions: any[] = [isNull(courses.deletedAt)];

		/* @info - Only PUBLISHED courses are ever listed for students: drafts
		 * must not surface in Explore or community catalogs. */
		conditions.push(eq(courses.status, "published"));

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
	listMine = async (authData: IAuthData, deleted = false) => {
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
			/* Instructor: courses they created (deleted=true → trash view) */
			const deletedFilter = deleted
				? isNotNull(courses.deletedAt)
				: isNull(courses.deletedAt);
			rows = await db
				.select(selectFields)
				.from(courses)
				.where(and(eq(courses.instructorId, authData.id), deletedFilter))
				.orderBy(desc(courses.updatedAt));
		} else {
			/* Student: enrolled courses (trash is owner-only — always live rows) */
			if (deleted) return [];
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
		const course = await this.coursesRepo.findById(id, {
			includeDeleted: true,
		});
		if (!course) throwNotFoundError(CourseMessages.NOT_FOUND);

		/* @info - Soft-deleted rows must be restored before any edit. Owners/
		 * admins get a 400 for ANY payload (not just status changes);
		 * non-owners get 404 so the existence of deleted courses is never
		 * disclosed. The normal non-deleted non-owner path keeps its 403. */
		if ((course as any).deletedAt) {
			if (!this.isOwnerOrAdmin(course as any, authData)) {
				throwNotFoundError(CourseMessages.NOT_FOUND);
			}
			throwBadRequestError("Restore this course before changing its status.");
		}

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

		/* @info - Allowlist: only whitelisted fields reach the DB. deletedAt /
		 * instructorId / communityId / id are stripped by the schema, closing
		 * the previous mass-assignment hole. */
		const parsed = updateCourseSchema.safeParse(coerced);
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			throwBadRequestError(issue?.message ?? "Invalid course update payload.");
		}
		const allowed = parsed.data as Record<string, any>;

		/* @info - Status transition matrix (owner/admin already asserted; the
		 * deletedAt case threw above, before any payload was parsed). */
		if (allowed.status !== undefined) {
			const from = (course as any).status;
			const to = allowed.status;
			if (from === "archived" && to === "published") {
				throwBadRequestError(
					"Republish from Drafts: unarchive first, then publish.",
				);
			}
			if (to === "archived" && from === "published") {
				this.log.info(`Course ${id} archived`);
			}
			if (to === "draft" && from === "archived") {
				this.log.info(`Course ${id} unarchived to draft`);
			}
		}

		const updated = await this.coursesRepo.update(id, allowed as any);
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

	restoreCourse = async (authData: IAuthData, id: number) => {
		const course = await this.coursesRepo.findById(id, {
			includeDeleted: true,
		});
		if (!course) throwNotFoundError(CourseMessages.NOT_FOUND);
		this.assertCourseOwner(course as any, authData);

		/* @info - Restore ALWAYS lands in draft, regardless of the status the
		 * course was frozen at when deleted. Re-publish is a separate click. */
		const updated = await this.coursesRepo.update(
			id,
			{ deletedAt: null, status: "draft" } as any,
			{ includeDeleted: true },
		);
		if (!updated) throwNotFoundError(CourseMessages.NOT_FOUND);

		/* @info - Symmetric with delete's decrement: a restored row re-enters
		 * the non-deleted set. */
		const db = getDb();
		await db
			.update(communities)
			.set({ courseCount: sql`${communities.courseCount} + 1` })
			.where(eq(communities.id, course!.communityId));

		this.log.info(`Course ${id} restored to draft`);
		return withPresignedUrl(updated!, "coverImageUrl");
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

	listModules = async (courseId: number, authData?: IAuthData) => {
		const db = getDb();
		const [course] = await db
			.select({
				id: courses.id,
				instructorId: courses.instructorId,
				status: courses.status,
			})
			.from(courses)
			.where(and(eq(courses.id, courseId), isNull(courses.deletedAt)))
			.limit(1);
		if (!course) throwNotFoundError(CourseMessages.NOT_FOUND);

		/* @info - Read gate: strangers on draft/archived get no curriculum. */
		const canRead = await this._canReadCourse(course as any, authData);
		if (!canRead) return [];

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
		data: NewLesson & LessonMeetingInput,
	) => {
		const mod = await this.modulesRepo.findById(moduleId);
		if (!mod) throwNotFoundError(ModuleMessages.NOT_FOUND);
		await this.assertOwnedModuleCourse(mod as any, authData);
		this.assertDriveLink(data.type, data.driveUrl);
		const { lessonData, meeting } = splitLessonMeeting(data);
		const lesson = await this.lessonsRepo.create({
			...lessonData,
			moduleId,
		} as any);
		/* @info - The meeting lives on the lesson's live session, not on the lesson */
		const session = await this.liveSessions.syncLessonMeeting(
			lesson.id,
			meeting,
		);
		/* @info - Publish immediately? Index it for the AI tutor */
		if (lesson.status === "published") {
			const { enqueueLessonForIndexing } = await import(
				"@/services/queues/lesson-chunk.queue.service"
			);
			await enqueueLessonForIndexing(lesson.id);
		}
		return { ...lesson, ...toLiveSessionFields(session) };
	};

	listLessons = async (moduleId: number, authData?: IAuthData) => {
		const db = getDb();
		const [mod] = await db
			.select({ courseId: modules.courseId })
			.from(modules)
			.where(eq(modules.id, moduleId))
			.limit(1);
		if (!mod) throwNotFoundError(ModuleMessages.NOT_FOUND);

		const [course] = await db
			.select({
				id: courses.id,
				instructorId: courses.instructorId,
				status: courses.status,
			})
			.from(courses)
			.where(
				and(eq(courses.id, Number(mod!.courseId)), isNull(courses.deletedAt)),
			)
			.limit(1);
		if (!course) throwNotFoundError(CourseMessages.NOT_FOUND);

		/* @info - Read gate: strangers on draft/archived get no curriculum. */
		const canRead = await this._canReadCourse(course as any, authData);
		if (!canRead) return [];

		const rows = await db
			.select()
			.from(lessons)
			.where(eq(lessons.moduleId, moduleId))
			.orderBy(asc(lessons.sortOrder), asc(lessons.id));

		/* @info - Meeting fields on a lesson payload come from its session now */
		return decorateLessonsWithSessions(rows);
	};

	updateLesson = async (
		authData: IAuthData,
		id: number,
		data: Partial<NewLesson> & LessonMeetingInput,
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
		const { lessonData, meeting } = splitLessonMeeting(data);
		/* @info - validate the merged state so clearing a link is impossible without changing type */
		this.assertDriveLink(
			lessonData.type ?? existing!.type,
			lessonData.driveUrl ?? existing!.driveUrl,
		);
		const lesson = await this.lessonsRepo.update(id, lessonData as any);
		/* @info - Meeting edits (schedule, url, kind, clearing) land on the session;
		 * syncLessonMeeting also re-arms an ended session when it is rescheduled, which
		 * is what made a reschedule look like it never committed. */
		const session = await this.liveSessions.syncLessonMeeting(id, meeting);
		/* @info - A published lesson that was edited gets re-embedded so the
		 * tutor never serves stale content */
		const merged = { ...existing, ...lessonData };
		if (lesson && merged.status === "published") {
			const { enqueueLessonForIndexing } = await import(
				"@/services/queues/lesson-chunk.queue.service"
			);
			await enqueueLessonForIndexing(id);
		}
		const updated = lesson ?? throwNotFoundError(LessonMessages.NOT_FOUND);
		return { ...updated, ...toLiveSessionFields(session) };
	};

	deleteLesson = async (authData: IAuthData, id: number): Promise<void> => {
		const lesson = await this.lessonsRepo.findById(id);
		if (!lesson) throwNotFoundError(LessonMessages.NOT_FOUND);
		const mod = await this.modulesRepo.findById(
			Number((lesson as any).moduleId),
		);
		if (!mod) throwNotFoundError(ModuleMessages.NOT_FOUND);
		await this.assertOwnedModuleCourse(mod as any, authData);
		/* @info - Read the session link before the row goes: lessons have no
		 * deleted_at, so softDelete hard-deletes and the link goes with it. Without
		 * this the session row would keep rendering in the calendar and stay
		 * reachable at /live/s/<id> with its lesson gone. */
		const sessionId = ((lesson as any).liveSessionId as number | null) ?? null;
		const deleted = await this.lessonsRepo.softDelete(id);
		if (!deleted) throwNotFoundError(LessonMessages.NOT_FOUND);
		if (sessionId) await this.liveSessions.discardSession(sessionId);
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

		/* @info - The generated link is an external meeting under the session model:
		 * the legacy lessons columns it used to write were dropped in migration 0028. */
		await this.liveSessions.syncLessonMeeting(lessonId, {
			meetingType: LessonMeetingType.EXTERNAL,
			meetingUrl: result.joinLink,
			scheduledAt: parseMeetingDate(options.startTime),
			durationMinutes: options.duration,
		});

		return result;
	};
}
