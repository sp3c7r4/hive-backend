import type { BaseUserService, RelationalRepository } from "@/bases";
import { UserTypes } from "@/enums";
import { AdminRepository, AdminService, admin } from "./admin";
import { UserRepository, UserService, user } from "./user";

export interface UserModelMapEntry {
	model: typeof user | typeof admin;
	label: UserTypes;
	service: BaseUserService;
	repository: RelationalRepository<typeof user | typeof admin>;
}

export type UserModelMap = Record<UserTypes, UserModelMapEntry>;

export const getUserMapper = (): UserModelMap => {
	return {
		[UserTypes.USER]: {
			model: user,
			label: UserTypes.USER,
			service: UserService.getInstance(),
			repository: UserRepository.getInstance(),
		},
		[UserTypes.ADMIN]: {
			model: admin,
			label: UserTypes.ADMIN,
			service: AdminService.getInstance(),
			repository: AdminRepository.getInstance(),
		},
	};
};
