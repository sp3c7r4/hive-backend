import { RelationalRepository } from "@/bases/repositories";
import { user_roles } from "./user-role.model";

export class UserRoleRepository extends RelationalRepository<typeof user_roles> {
	private static instance: UserRoleRepository;

	static getInstance(): UserRoleRepository {
		if (!this.instance) this.instance = new UserRoleRepository();
		return this.instance;
	}

	private constructor() {
		super(user_roles);
	}
}
