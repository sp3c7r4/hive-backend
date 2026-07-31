import { zValidator } from "@hono/zod-validator";
import { StatusCodes } from "http-status-codes";
import type { z } from "zod";
import type { ZodIssue } from "zod/v3";
import { sendErrorResponse } from "@/helpers";
import { serviceLogger } from "@/utils";

/**
 * @info This is a validation engine for Zod
 * @description - Provides middleware for validating request bodies, query parameters, and route parameters using Zod schemas.
 */
export class ZodEngine {
	private static instance: ZodEngine;

	/** @info - Utils */
	private readonly log = serviceLogger("Zod Engine");

	/** @returns {ZodEngine} */
	static getInstance(): ZodEngine {
		if (!this.instance) {
			this.instance = new ZodEngine();
		}
		return this.instance;
	}

	private constructor() {}

	/**
	 * @info - Validates the request body, params, and query
	 * @param {z.ZodSchema} schema - The schema to validate the request body, params, and query
	 * @returns {z.ZodSchema} - The validated schema
	 */
	validate = {
		body: (schema: z.ZodSchema) => this.validateBody(schema),
		params: (schema: z.ZodSchema) => this.validateParams(schema),
		query: (schema: z.ZodSchema) => this.validateQuery(schema),
		formData: (schema: z.ZodSchema) => this.validateFormData(schema),
	};

	private handleResult = (result: any, c: any): Response | undefined => {
		if (!result.success) {
			const issues = JSON.parse(result.error.message);

			const errorMessages: Record<any, any> = {};
			issues.forEach((issue: ZodIssue) => {
				const { path, message } = issue;
				errorMessages[path.join(".")] = message;
			});
			console.log(issues, result);
			return sendErrorResponse(c, errorMessages, StatusCodes.BAD_REQUEST);
		}
		this.log.info(`Serialized result: ${JSON.stringify(result)}`);
	};

	/** @private */
	private validateBody = (schema: z.ZodSchema) => {
		return zValidator("json", schema, this.handleResult);
	};

	private validateFormData = (schema: z.ZodSchema) => {
		return zValidator("form", schema, this.handleResult);
	};

	/** @private */
	private validateParams = (schema: z.ZodSchema) => {
		return zValidator("param", schema, this.handleResult);
	};

	/** @private */
	private validateQuery = (schema: z.ZodSchema) => {
		return zValidator("query", schema, this.handleResult);
	};
}
