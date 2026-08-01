import { MeetingSchedulerService } from "@/services/meeting-scheduler.service";
import { eq } from "drizzle-orm";
import { throwNotFoundError } from "@/helpers/errors/throw-errors";
import { PaginationService } from "@/services/pagination.service";
import { serviceLogger } from "@/utils";
import { CourseMessages, ModuleMessages, LessonMessages } from "./course.message";
import { courses } from "./course.model";
import {
	CourseRepository,
	ModuleRepository,
	LessonRepository,
} from "./course.repository";
import type { NewCourse, NewModule, NewLesson } from "./course.model";

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

	createCourse = async (data: NewCourse) => {
		return this.coursesRepo.create(data as any);
	};

	getCourse = async (id: number) => {
		const course = await this.coursesRepo.findById(id);
		return course ?? throwNotFoundError(CourseMessages.NOT_FOUND);
	};

	listCourses = async (params?: { page?: number; limit?: number }) => {
		return this.paginationService.paginate({
			page: params?.page ?? 1,
			limit: params?.limit ?? 20,
		});
	};

	updateCourse = async (id: number, data: Partial<NewCourse>) => {
		const course = await this.coursesRepo.update(id, data as any);
		return course ?? throwNotFoundError(CourseMessages.NOT_FOUND);
	};

	deleteCourse = async (id: number): Promise<void> => {
		const course = await this.coursesRepo.softDelete(id);
		if (!course) throwNotFoundError(CourseMessages.NOT_FOUND);
		this.log.info(`Course ${id} soft-deleted`);
	};

	/* Modules */

	createModule = async (courseId: number, data: NewModule) => {
		return this.modulesRepo.create({ ...data, courseId } as any);
	};

	listModules = async (courseId: number) => {
		return this.modulesRepo.findMany(
			eq(this.modulesRepo.getModel().courseId as any, courseId),
		);
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
		return this.lessonsRepo.findMany(
			eq(this.lessonsRepo.getModel().moduleId as any, moduleId),
		);
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
