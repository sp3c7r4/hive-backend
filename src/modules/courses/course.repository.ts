import { RelationalRepository } from "@/bases";
import { courses, modules, lessons } from "./course.model";
import { eq, and } from "drizzle-orm";

export class CourseRepository extends RelationalRepository<typeof courses> {
	private static instance: CourseRepository;

	static getInstance(): CourseRepository {
		if (!this.instance) this.instance = new CourseRepository();
		return this.instance;
	}

	private constructor() {
		super(courses);
	}
}

export class ModuleRepository extends RelationalRepository<typeof modules> {
	private static instance: ModuleRepository;

	static getInstance(): ModuleRepository {
		if (!this.instance) this.instance = new ModuleRepository();
		return this.instance;
	}

	private constructor() {
		super(modules);
	}

	findByCourse = async (courseId: number) => {
		return this.findMany(eq(modules.courseId, courseId));
	};
}

export class LessonRepository extends RelationalRepository<typeof lessons> {
	private static instance: LessonRepository;

	static getInstance(): LessonRepository {
		if (!this.instance) this.instance = new LessonRepository();
		return this.instance;
	}

	private constructor() {
		super(lessons);
	}

	findByModule = async (moduleId: number) => {
		return this.findMany(eq(lessons.moduleId, moduleId));
	};
}
