import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { and, count as drizzleCount, eq, isNull, type SQL } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import { HTTPException } from "hono/http-exception";
import { getDb } from "@/db/postgres.db";
import { serviceLogger } from "@/utils";
import { throwInternalServerError } from "@/helpers/errors/throw-errors";

export type DbClient = ReturnType<typeof getDb>;

interface RepoOptions {
	includeDeleted?: boolean;
}

export class RelationalRepository<T extends AnyPgTable & { id: any }> {
	private _model: T;
	private _explicitDb?: DbClient;
	private readonly log;

	constructor(model: T, db?: DbClient) {
		this._model = model;
		this._explicitDb = db;
		this.log = serviceLogger("Relational Repository");
	}

	protected get _db(): DbClient {
		return this._explicitDb ?? getDb();
	}

	/** @info - Returns true if this table has a deleted_at column */
	private get _hasSoftDelete(): boolean {
		return "deleted_at" in (this._model as any);
	}

	/** @info - Adds WHERE deleted_at IS NULL unless includeDeleted is set */
	private _softDeleteFilter(opts?: RepoOptions): SQL | undefined {
		if (!this._hasSoftDelete) return undefined;
		if (opts?.includeDeleted) return undefined;
		return isNull((this._model as any).deleted_at);
	}

	/** @info - Merges a user where clause with the soft-delete filter */
	private _mergeWhere(userWhere?: SQL, opts?: RepoOptions): SQL | undefined {
		const sd = this._softDeleteFilter(opts);
		if (!sd && !userWhere) return undefined;
		if (!sd) return userWhere!;
		if (!userWhere) return sd;
		return and(userWhere, sd)!;
	}

	/**
	 * @info - Wraps a DB operation with error logging. Prevents raw SQL/connection
	 *         errors from leaking to the client. Logs full cause chain then throws
	 *         a generic 500.
	 */
	private async _guard<R>(operation: () => Promise<R>): Promise<R> {
		try {
			return await operation();
		} catch (error: any) {
			/* Re-throw app-level HTTP exceptions unchanged */
			if (error instanceof HTTPException) {
				throw error;
			}

			const cause = error?.cause;
			const causeInfo = cause
				? ` | cause: ${cause.message ?? cause}${
						cause.code ? ` (code: ${cause.code})` : ""
					}${cause.detail ? ` detail: ${cause.detail}` : ""}`
				: "";
			this.log.error(
				`DB error: ${error.message}${causeInfo}`,
			);
			throwInternalServerError(
				"An unexpected database error occurred. Please try again later.",
			);
			throw undefined as never; // TS: unreachable, satisfies return type
		}
	}

	findById = async (id: number, opts?: RepoOptions): Promise<InferSelectModel<T> | undefined> => {
		return this._guard(async () => {
			const where = this._mergeWhere(eq(this._model.id, id), opts);
			const [row] = await this._db
				.select()
				.from(this._model as any)
				.where(where!)
				.limit(1);
			return row as InferSelectModel<T> | undefined;
		});
	};

	findOne = async (where: SQL, opts?: RepoOptions): Promise<InferSelectModel<T> | undefined> => {
		return this._guard(async () => {
			const merged = this._mergeWhere(where, opts);
			const [row] = await this._db
				.select()
				.from(this._model as any)
				.where(merged!)
				.limit(1);
			return row as InferSelectModel<T> | undefined;
		});
	};

	findMany = async (where?: SQL, opts?: RepoOptions): Promise<InferSelectModel<T>[]> => {
		return this._guard(async () => {
			const query = this._db.select().from(this._model as any);
			const merged = this._mergeWhere(where, opts);
			if (merged) query.where(merged);
			return (await query) as InferSelectModel<T>[];
		});
	};

	findPaginated = async (
		page: number,
		pageSize: number,
		where?: SQL,
		opts?: RepoOptions,
	): Promise<{ data: InferSelectModel<T>[]; total: number }> => {
		return this._guard(async () => {
			const merged = this._mergeWhere(where, opts);
			const query = this._db.select().from(this._model as any);
			if (merged) query.where(merged);
			const data = (await query
				.limit(pageSize)
				.offset((page - 1) * pageSize)) as InferSelectModel<T>[];
			const countQuery = this._db
				.select({ value: drizzleCount() })
				.from(this._model as any);
			if (merged) countQuery.where(merged);
			const [{ value }]: any = await countQuery;
			return { data, total: value };
		});
	};

	create = async (data: InferInsertModel<T>): Promise<InferSelectModel<T>> => {
		return this._guard(async () => {
			const [row] = await this._db
				.insert(this._model)
				.values(data as any)
				.returning();
			return row as InferSelectModel<T>;
		});
	};

	createMany = async (
		data: InferInsertModel<T>[],
	): Promise<InferSelectModel<T>[]> => {
		return this._guard(async () => {
			const rows = await this._db
				.insert(this._model)
				.values(data as any)
				.returning();
			return rows as InferSelectModel<T>[];
		});
	};

	update = async (
		id: number,
		data: Partial<InferInsertModel<T>>,
		opts?: RepoOptions,
	): Promise<InferSelectModel<T> | undefined> => {
		return this._guard(async () => {
			const where = this._mergeWhere(eq(this._model.id, id), opts);
			const [row]: any = await this._db
				.update(this._model)
				.set(data as any)
				.where(where!)
				.returning();
			return row as InferSelectModel<T> | undefined;
		});
	};

	updateWhere = async (
		where: SQL,
		data: Partial<InferInsertModel<T>>,
	): Promise<InferSelectModel<T>[]> => {
		return this._guard(async () => {
			const rows = await this._db
				.update(this._model)
				.set(data as any)
				.where(where)
				.returning();
			return rows as InferSelectModel<T>[];
		});
	};

	upsert = async (
		where: SQL,
		data: InferInsertModel<T>,
	): Promise<InferSelectModel<T>> => {
		return this._guard(async () => {
			const existing = await this.findOne(where);

			if (existing) {
				const [row]: any = await this._db
					.update(this._model)
					.set(data as any)
					.where(where)
					.returning();
				return row as InferSelectModel<T>;
			}

			return await this.create(data);
		});
	};

	softDelete = async (id: number): Promise<InferSelectModel<T> | undefined> => {
		return this._guard(async () => {
			if (!this._hasSoftDelete) {
				return this.delete(id);
			}
			const [row]: any = await this._db
				.update(this._model)
				.set({ deleted_at: new Date() } as any)
				.where(eq(this._model.id, id))
				.returning();
			return row as InferSelectModel<T> | undefined;
		});
	};

	delete = async (id: number): Promise<InferSelectModel<T> | undefined> => {
		return this._guard(async () => {
			const [row] = await this._db
				.delete(this._model)
				.where(eq(this._model.id, id))
				.returning();
			return row as InferSelectModel<T> | undefined;
		});
	};

	deleteWhere = async (where: SQL): Promise<InferSelectModel<T>[]> => {
		return this._guard(async () => {
			const rows = await this._db.delete(this._model).where(where).returning();
			return rows as InferSelectModel<T>[];
		});
	};

	count = async (where?: SQL, opts?: RepoOptions): Promise<number> => {
		return this._guard(async () => {
			const merged = this._mergeWhere(where, opts);
			const query = this._db
				.select({ value: drizzleCount() })
				.from(this._model as any);
			if (merged) query.where(merged);
			const [{ value }]: any = await query;
			return Number(value);
		});
	};

	exists = async (where: SQL, opts?: RepoOptions): Promise<boolean> => {
		return this._guard(async () => {
			const merged = this._mergeWhere(where, opts);
			const [row]: any = await this._db
				.select({ value: drizzleCount() })
				.from(this._model as any)
				.where(merged!)
				.limit(1);
			return row.value > 0;
		});
	};

	transaction = async <R>(fn: (txRepo: this) => Promise<R>): Promise<R> => {
		return await this._db.transaction(async (tx) => {
			const txRepo = new (this.constructor as any)(this._model, tx);
			return fn(txRepo);
		});
	};

	getModel = () => this._model;
}
