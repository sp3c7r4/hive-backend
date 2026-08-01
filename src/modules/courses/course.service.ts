import { eq } from "drizzle-orm";
import {
	CourseRepository,
	ModuleRepository,
	LessonRepository,
} from "./course.repository";
import type { NewCourse, NewModule, NewLesson } from "./course.model";

export class CourseService {
	private static instance: CourseService;

	private readonly courses: CourseRepository;
	private readonly modules: ModuleRepository;
	private readonly lessons: LessonRepository;

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
		return this.courses.findById(id);
	};

	listCourses = async (page = 1, limit = 20) => {
		return this.courses.findPaginated(page, limit);
	};

	updateCourse = async (id: number, data: Partial<NewCourse>) => {
		return this.courses.update(id, data as any);
	};

	deleteCourse = async (id: number) => {
		return this.courses.softDelete(id);
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
		return this.modules.update(id, data as any);
	};

	deleteModule = async (id: number) => {
		await this.modules.delete(id);
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
		return this.lessons.update(id, data as any);
	};

	deleteLesson = async (id: number) => {
		await this.lessons.delete(id);
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
