import { RelationalRepository } from "@/bases/repositories";
import { users } from "./user.model";

export class UserRepository extends RelationalRepository<typeof users> {
	private static instance: UserRepository;

	static getInstance(): UserRepository {
		if (!this.instance) this.instance = new UserRepository();
		return this.instance;
	}

	private constructor() {
		super(users);
	}
}
