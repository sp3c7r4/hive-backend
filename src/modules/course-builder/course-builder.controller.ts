import type { Context } from "hono";
import { throwBadRequestError } from "@/helpers/errors/throw-errors";
import { CourseBuilderService } from "./course-builder.service";

export class CourseBuilderController {
	private static instance: CourseBuilderController;
	private readonly service = CourseBuilderService.getInstance();

	static getInstance(): CourseBuilderController {
		if (!this.instance) this.instance = new CourseBuilderController();
		return this.instance;
	}

	/** @info - POST /ai/course-builder
	 * Streaming object draft when clean; 400 error envelope when the
	 * syllabus tripped a guardrail. The client distinguishes by response
	 * shape (stream vs JSON error). */
	draft = async (c: Context) => {
		const authData = c.get("authData");
		const { syllabus } = await c.req.json();

		const result = await this.service.streamDraft(authData.id, syllabus);
		if (result.kind === "stream") return result.response;
		throwBadRequestError(
			result.reason === "pii"
				? "Please do not share personal contact details in the syllabus."
				: "That syllabus is not allowed. Remove any instruction-override wording and try again.",
		);
	};

	/** @info - POST /ai/course-builder/module — regenerate one module */
	moduleRegenerate = async (c: Context) => {
		const authData = c.get("authData");
		const body = await c.req.json();

		const result = await this.service.streamModule(authData.id, body);
		if (result.kind === "stream") return result.response;
		throwBadRequestError(
			result.reason === "pii"
				? "Please do not share personal contact details in course content."
				: "That request is not allowed. Remove any instruction-override wording and try again.",
		);
	};
}
