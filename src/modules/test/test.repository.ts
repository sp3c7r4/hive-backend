import { RelationalRepository } from "@/bases";
import { test } from "./test.schema";

export class TestRepository extends RelationalRepository<typeof test> {
	private static instance: TestRepository;

	static getInstance(): TestRepository {
		if (!this.instance) this.instance = new TestRepository();
		return this.instance;
	}

	private constructor() {
		super(test);
	}
}
