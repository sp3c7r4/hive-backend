import { pgEnum } from "drizzle-orm/pg-core";
import { UserRole } from "@/enums";

/**
 * @info - Single shared pgEnum for user roles. Imported by users, user_roles,
 *         and any table that stores a role column for context.
 */
export const userRoleEnum = pgEnum("user_role", Object.values(UserRole) as [string, ...string[]]);
