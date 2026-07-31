import {
	BadRequestError,
	ConflictError,
	ForbiddenError,
	InternalServerError,
	NotFoundError,
	UnauthorizedError,
} from "@/errors";

export const throwNotFoundError = (message: string): never => {
	throw new NotFoundError(message);
};

export const throwBadRequestError = (message: string): never => {
	throw new BadRequestError(message);
};

export const throwUnauthorizedError = (message: string): never => {
	throw new UnauthorizedError(message);
};

export const throwForbiddenError = (message: string): never => {
	throw new ForbiddenError(message);
};

export const throwInternalServerError = (message: string): never => {
	throw new InternalServerError(message);
};

export const throwConflictError = (message: string): never => {
	throw new ConflictError(message);
};
