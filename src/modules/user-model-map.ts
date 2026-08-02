import { users, UserRepository } from "@/models/user.model";
import { user_roles, UserRoleRepository } from "@/models/user-role.model";

/**
 * @info - Central registry of user-domain models and their repositories.
 *         Use the singleton .getInstance() repositories directly.
 */
export const userModels = { users, user_roles } as const;

export { UserRepository, UserRoleRepository };
