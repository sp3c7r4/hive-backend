import { RelationalRepository } from "@/bases";
import { courses, modules, lessons } from "./course.model";

export class CourseRepository extends RelationalRepository<typeof courses> {
	private static instance: CourseRepository | null;

	static getInstance(): CourseRepository {
		if (!this.instance) this.instance = new CourseRepository();
		return this.instance;
	}

	private constructor() {
		super(courses);
	}
}

export class ModuleRepository extends RelationalRepository<typeof modules> {
	private static instance: ModuleRepository | null;

	static getInstance(): ModuleRepository {
		if (!this.instance) this.instance = new ModuleRepository();
		return this.instance;
	}

	private constructor() {
		super(modules);
	}
}

export class LessonRepository extends RelationalRepository<typeof lessons> {
	private static instance: LessonRepository | null;

	static getInstance(): LessonRepository {
		if (!this.instance) this.instance = new LessonRepository();
		return this.instance;
	}

	private constructor() {
		super(lessons);
	}
}
