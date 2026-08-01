import { eq } from "drizzle-orm";
import { throwNotFoundError } from "@/helpers/errors";
import { serviceLogger } from "@/utils";
import { TestRepository } from "./test.repository";
import { test, type NewTest, type Test } from "./test.schema";

export class TestService {
	private static instance: TestService;

	private readonly repository: TestRepository;
	private readonly log = serviceLogger("TestService");

	static getInstance(): TestService {
		if (!this.instance) this.instance = new TestService();
		return this.instance;
	}

	private constructor() {
		this.repository = TestRepository.getInstance();
	}

	getAll = async (): Promise<Test[]> => {
		return await this.repository.findMany();
	};

	getById = async (id: number): Promise<Test> => {
		const record = await this.repository.findById(id);
		if (!record) throwNotFoundError("Test record not found");
		return record!;
	};

	create = async (data: NewTest): Promise<Test> => {
		return await this.repository.create(data) as Test;
	};

	update = async (id: number, data: Partial<NewTest>): Promise<Test> => {
		const updated = await this.repository.update(id, data);
		if (!updated) throwNotFoundError("Test record not found");
		return updated as Test;
	};

	delete = async (id: number): Promise<Test> => {
		const deleted = await this.repository.delete(id);
		if (!deleted) throwNotFoundError("Test record not found");
		return deleted as Test;
	};
}
