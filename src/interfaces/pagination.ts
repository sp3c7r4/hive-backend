import type { SQL } from "drizzle-orm";

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
