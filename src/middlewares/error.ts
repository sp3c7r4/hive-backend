import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ReasonPhrases, StatusCodes } from "http-status-codes";
import { createConflictError } from "@/errors/Conflict";
import { sendErrorResponse } from "@/helpers";

interface ErrorObject {
	status?: ContentfulStatusCode;
	message?: string;
}

export const errorHandler = (err: any, c: Context) => {
	const errorObject: ErrorObject = {};

	console.log("Error Stack", err);

	if (err instanceof Error) {
		errorObject.status = StatusCodes.INTERNAL_SERVER_ERROR;
		errorObject.message = err.message || ReasonPhrases.INTERNAL_SERVER_ERROR;
	}

	if (err instanceof HTTPException) {
		errorObject.status = err.status;
		errorObject.message = err.message || ReasonPhrases.INTERNAL_SERVER_ERROR;
	}

	if (err && err.name === "ValidationError") {
		errorObject.status = StatusCodes.BAD_REQUEST;
		errorObject.message = err.message.split(": ").pop();
	}

	if (err && (err.code === 11000 || err.cause?.code === 11000)) {
		const mongoError = err.cause || err;
		const message = Object.keys(mongoError.keyValue || {}).join(", ");
		const newConflictError = createConflictError(`${message} already exist`);
		errorObject.status = newConflictError.status;
		errorObject.message = newConflictError.message;
	}

	if (
		err &&
		(err.name === "JsonWebTokenError" || err.name === "TokenExpiredError")
	) {
		errorObject.message = /malformed|algorithm/.test(err.message)
			? "Invalid token"
			: "Session expired";
		errorObject.status = StatusCodes.UNAUTHORIZED;
	}

	if (err && err.name === "CastError") {
		errorObject.message = `${err?.value} is not a valid ${err?.kind}`;
		errorObject.status = StatusCodes.BAD_REQUEST;
	}

	if (err && err.name === "BSONError") {
		errorObject.status = StatusCodes.BAD_REQUEST;
		errorObject.message = err?.message || ReasonPhrases.BAD_REQUEST;
	}

	if (
		err &&
		(err.type === "entity.parse.failed" || err.name === "SyntaxError")
	) {
		errorObject.status = err?.statusCode || err?.status;
		errorObject.message = err?.message?.includes("JSON")
			? "Invalid JSON format in the request body. Please ensure there are no trailing commas."
			: "Syntax Error: Invalid data format.";
	}

	if (err && err.name === "MulterError") {
		errorObject.status = StatusCodes.UNPROCESSABLE_ENTITY;
		errorObject.message = `${err?.message} ${err.field}`;
	}

	return sendErrorResponse(
		c,
		{
			message: errorObject.message || ReasonPhrases.INTERNAL_SERVER_ERROR,
		},
		errorObject.status || StatusCodes.INTERNAL_SERVER_ERROR,
	);
};
