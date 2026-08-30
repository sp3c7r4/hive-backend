import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { WSContext } from "hono/ws";
import { StatusCodes } from "http-status-codes";

export const sendSuccessResponse = (
	c: Context,
	data: unknown | unknown[],
	statusCode: ContentfulStatusCode = StatusCodes.OK,
) => {
  console.log("Response: ", data)
	return c.json(
		{
			timestamp: new Date().toISOString(),
			status: statusCode,
			success: true,
			data,
		},
		statusCode,
	);
};

export const sendErrorResponse = (
	c: Context,
	error: ErrorData,
	statusCode: ContentfulStatusCode = StatusCodes.INTERNAL_SERVER_ERROR,
) => {
	return c.json(
		{
			timestamp: new Date().toISOString(),
			status: statusCode,
			success: false,
			error,
		},
		statusCode,
	);
};

export const sendWsSuccessResponse = <T>(
	ws: WSContext<any>,
	data: T,
	statusCode: ContentfulStatusCode = StatusCodes.OK,
) => {
	return ws.send(
		JSON.stringify({
			timestamp: new Date().toISOString(),
			status: statusCode,
			success: true,
			data,
		}),
	);
};

export const sendWsErrorResponse = (
	ws: WSContext<any>,
	message: unknown | string,
	statusCode: ContentfulStatusCode = StatusCodes.INTERNAL_SERVER_ERROR,
) => {
	ws.send(
		JSON.stringify({
			timestamp: new Date().toISOString(),
			status: statusCode,
			success: false,
			error: {
				type: "ERROR",
				message,
			},
		}),
	);
	ws.close();
};

interface Response<T = unknown> {
	timestamp: string;
	status: number;
	success: boolean;
	data?: T;
	error?: T;
	[key: string]: any;
}
interface ErrorData {
	message?: string | any;
	[key: string]: any;
}

interface SuccessData<T> {
	message?: string | any;
	data: T;
}

interface ErrorResponse extends Response<ErrorData> {}
interface SuccessResponse<D> extends Response<SuccessData<D>> {}

type ApiResponse<D = unknown> = ErrorResponse | SuccessResponse<D>;

export const sendAiSuccessResponse = <S extends Record<string, any>>(
	data: SuccessData<S>,
	status: ContentfulStatusCode = StatusCodes.OK,
): ApiResponse<S> => {
	return {
		timestamp: new Date().toISOString(),
		success: true,
		status,
		data,
	};
};

export const sendAiErrorResponse = (
	error: ErrorData,
	status: ContentfulStatusCode = StatusCodes.OK,
): ApiResponse => {
	return {
		timestamp: new Date().toISOString(),
		success: false,
		status,
		error,
	};
};
