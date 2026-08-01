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
	private static instance: CourseService | null;

	/** @info - Repositories */
	private readonly courses: CourseRepository;
	private readonly modules: ModuleRepository;
	private readonly lessons: LessonRepository;
	/** @info - Services */
	private readonly paginationService = new PaginationService<typeof courses>(courses);
	/** @info - Utilities */
	private readonly log = serviceLogger("Course");

	static getInstance(): CourseService {
		if (!this.instance) this.instance = new CourseService();
		return this.instance;
	}

	private constructor() {
		this.courses = CourseRepository.getInstance();
		this.modules = ModuleRepository.getInstance();
		this.lessons = LessonRepository.getInstance();
	}

	/** @info - Courses */
	createCourse = async (data: NewCourse & { instructorId: number }) => {
		const slug = this._slugify(data.title, data.instructorId);
		return this.courses.create({ ...data, slug } as any);
	};

	getCourse = async (id: number) => {
		const course = await this.courses.findById(id);
		if (!course) throwNotFoundError(CourseMessages.NOT_FOUND);
		return course;
	};

	listCourses = async (params?: { page?: number; limit?: number }) => {
		return this.paginationService.paginate({
			page: params?.page ?? 1,
			limit: params?.limit ?? 20,
		});
	};

	updateCourse = async (id: number, data: Partial<NewCourse>) => {
		const course = await this.courses.update(id, data as any);
		if (!course) throwNotFoundError(CourseMessages.NOT_FOUND);
		return course;
	};

	deleteCourse = async (id: number): Promise<void> => {
		const course = await this.courses.softDelete(id);
		if (!course) throwNotFoundError(CourseMessages.NOT_FOUND);
		this.log.info(`Course ${id} soft-deleted`);
	};

	/** @info - Modules */
	createModule = async (data: NewModule) => {
		return this.modules.create(data as any);
	};

	listModules = async (courseId: number) => {
		return this.modules.findMany(
			eq(this.modules.getModel().courseId as any, courseId),
		);
	};

	updateModule = async (id: number, data: Partial<NewModule>) => {
		const mod = await this.modules.update(id, data as any);
		if (!mod) throwNotFoundError(ModuleMessages.NOT_FOUND);
		return mod;
	};

	deleteModule = async (id: number): Promise<void> => {
		const mod = await this.modules.delete(id);
		if (!mod) throwNotFoundError(ModuleMessages.NOT_FOUND);
		this.log.info(`Module ${id} deleted`);
	};

	/** @info - Lessons */
	createLesson = async (data: NewLesson) => {
		return this.lessons.create(data as any);
	};

	listLessons = async (moduleId: number) => {
		return this.lessons.findMany(
			eq(this.lessons.getModel().moduleId as any, moduleId),
		);
	};

	updateLesson = async (id: number, data: Partial<NewLesson>) => {
		const lesson = await this.lessons.update(id, data as any);
		if (!lesson) throwNotFoundError(LessonMessages.NOT_FOUND);
		return lesson;
	};

	deleteLesson = async (id: number): Promise<void> => {
		const lesson = await this.lessons.delete(id);
		if (!lesson) throwNotFoundError(LessonMessages.NOT_FOUND);
		this.log.info(`Lesson ${id} deleted`);
	};

	private _slugify = (title: string, instructorId: number): string => {
		const base = title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "");
		const suffix = instructorId.toString(36).slice(-4);
		return `${base}-${suffix}`;
	};
}
