import { users } from "@/models/user.model";
import { user_roles } from "@/models/user-role.model";
import { UserRepository } from "@/models/user.repository";
import { UserRoleRepository } from "@/models/user-role.repository";

/**
 * @info - Central registry of user-domain models and their repositories.
 *         Use the singleton .getInstance() repositories directly.
 */
export const userModels = { users, user_roles } as const;

export { UserRepository, UserRoleRepository };
