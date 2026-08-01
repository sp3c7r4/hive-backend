import { instructors } from "@/modules/instructor/instructor.model";
import { students } from "@/modules/student/student.model";
import { parents } from "@/modules/parent/parent.model";
import { UserRole } from "@/enums";
import { RelationalRepository } from "@/bases/repositories";

/**
 * @info - Maps each UserRole to its Drizzle model and repository.
 * Used by AuthService to resolve which table to query for a given role.
 */
export function getUserMapper() {
	return {
		[UserRole.INSTRUCTOR]: {
			model: instructors,
			repository: new RelationalRepository(instructors),
			label: "instructor",
		},
		[UserRole.STUDENT]: {
			model: students,
			repository: new RelationalRepository(students),
			label: "student",
		},
		[UserRole.PARENT]: {
			model: parents,
			repository: new RelationalRepository(parents),
			label: "parent",
		},
	} as const;
}

export type UserModelEntry = ReturnType<typeof getUserMapper>[keyof ReturnType<typeof getUserMapper>];
