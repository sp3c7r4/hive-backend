import type { InferSelectModel, SQL } from "drizzle-orm";
import { asc, desc, count as drizzleCount, gt, lt } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import type {
	CursorPaginatedResult,
	CursorPaginateOptions,
	PaginatedResult,
	PaginateOptions,
} from "@/interfaces";

const MAX_LIMIT = 100;

type DbClient = ReturnType<typeof getDb>;

export class PaginationService<T extends Record<string, any>> {
	private readonly model: T;
	private readonly _explicitDb?: DbClient;

	constructor(model: T, db?: DbClient) {
		this.model = model;
		this._explicitDb = db;
	}

	private get db(): DbClient {
		return this._explicitDb ?? getDb();
	}

	async paginate({
		page = 1,
		limit = 10,
		where,
		orderBy,
	}: PaginateOptions = {}): Promise<PaginatedResult<InferSelectModel<any>>> {
		const safePage = Math.max(1, Number(page));
		const safeLimit = Math.max(1, Math.min(Number(limit), MAX_LIMIT));
		const offset = (safePage - 1) * safeLimit;

		const dataQuery = this.db.select().from(this.model as any);
		const countQuery = this.db
			.select({ value: drizzleCount() })
			.from(this.model as any);

		if (where) {
			dataQuery.where(where);
			countQuery.where(where);
		}

		if (orderBy) {
			const orderFn = orderBy.direction === "desc" ? desc : asc;
			dataQuery.orderBy(orderFn(orderBy.column));
		} else {
			dataQuery.orderBy(desc((this.model as any).created_at));
		}

		const [data, [{ value: total }]]: any = await Promise.all([
			dataQuery.limit(safeLimit).offset(offset),
			countQuery,
		]);

		const totalPages = Math.ceil(total / safeLimit);

		return {
			data,
			meta: {
				total,
				page: safePage,
				limit: safeLimit,
				totalPages,
				hasNextPage: safePage < totalPages,
				hasPrevPage: safePage > 1,
				nextPage: safePage < totalPages ? safePage + 1 : null,
				prevPage: safePage > 1 ? safePage - 1 : null,
			},
		};
	}

	async cursorPaginate({
		cursor,
		limit = 10,
		where,
		orderBy,
	}: CursorPaginateOptions = {}): Promise<
		CursorPaginatedResult<InferSelectModel<any>>
	> {
		const safeLimit = Math.max(1, Math.min(Number(limit), MAX_LIMIT));

		const column = orderBy?.column ?? (this.model as any).id;
		const direction = orderBy?.direction ?? "asc";
		const orderFn = direction === "desc" ? desc : asc;
		const cursorOp = direction === "asc" ? gt : lt;

		const conditions: SQL[] = [];
		if (where) conditions.push(where);
		if (cursor) conditions.push(cursorOp(column, cursor));

		const query = this.db
			.select()
			.from(this.model as any)
			.orderBy(orderFn(column))
			.limit(safeLimit + 1);

		if (conditions.length) {
			const { and } = await import("drizzle-orm");
			query.where(and(...conditions));
		}

		const rows: any[] = await query;

		const hasNextPage = rows.length > safeLimit;
		if (hasNextPage) rows.pop();

		const nextCursor = hasNextPage
			? rows[rows.length - 1]?.[column.name]
			: null;

		return {
			data: rows,
			meta: {
				limit: safeLimit,
				hasNextPage,
				nextCursor,
			},
		};
	}
}
