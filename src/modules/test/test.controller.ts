import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendSuccessResponse } from "@/helpers";
import { TestService } from "./test.service";
import type { NewTest } from "./test.schema";

export class TestController {
	private static instance: TestController;

	private readonly service: TestService;

	static getInstance(): TestController {
		if (!this.instance) this.instance = new TestController();
		return this.instance;
	}

	private constructor() {
		this.service = TestService.getInstance();
	}

	getAll = async (c: Context) => {
		const data = await this.service.getAll();
		return sendSuccessResponse(c, data);
	};

	getById = async (c: Context) => {
		const id = Number(c.req.param("id"));
		const data = await this.service.getById(id);
		return sendSuccessResponse(c, data);
	};

	create = async (c: Context) => {
		const body = await c.req.json<NewTest>();
		const data = await this.service.create(body);
		return sendSuccessResponse(c, data, StatusCodes.CREATED);
	};

	update = async (c: Context) => {
		const id = Number(c.req.param("id"));
		const body = await c.req.json<Partial<NewTest>>();
		const data = await this.service.update(id, body);
		return sendSuccessResponse(c, data);
	};

	delete = async (c: Context) => {
		const id = Number(c.req.param("id"));
		const data = await this.service.delete(id);
		return sendSuccessResponse(c, data);
	};
}
