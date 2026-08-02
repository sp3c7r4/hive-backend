import { users } from "@/modules/user/user.model";
import { user_roles } from "@/modules/user/user-role.model";
import { UserRepository } from "@/modules/user/user.repository";
import { UserRoleRepository } from "@/modules/user/user-role.repository";

/**
 * @info - Central registry of user-domain models and their repositories.
 *         Use the singleton .getInstance() repositories directly.
 */
export const userModels = { users, user_roles } as const;

export { UserRepository, UserRoleRepository };
