import type { SQL } from "drizzle-orm";
import type { PopulateOptions } from "mongoose";

export interface PaginateOptions {
	page?: number;
	limit?: number;
	where?: SQL;
	orderBy?: { column: any; direction: "asc" | "desc" };
}

export interface CursorPaginateOptions {
	cursor?: string | number | Date | null;
	limit?: number;
	where?: SQL;
	orderBy?: { column: any; direction: "asc" | "desc" };
}

export interface PaginatedResult<T> {
	data: T[];
	meta: {
		total: number;
		page: number;
		limit: number;
		totalPages: number;
		hasNextPage: boolean;
		hasPrevPage: boolean;
		nextPage: number | null;
		prevPage: number | null;
	};
}

export interface CursorPaginatedResult<T> {
	data: T[];
	meta: {
		limit: number;
		hasNextPage: boolean;
		nextCursor: string | number | Date | null;
	};
}

export interface QueryBuilderParams<T> {
	page: number;
	limit: number;
	filter: Partial<T>;
}

export interface QueryBuilder<T> extends QueryBuilderParams<T> {
	select: string;
	populate?: PopulateOptions[];
}
