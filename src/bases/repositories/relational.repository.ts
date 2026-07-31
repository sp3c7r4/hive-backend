import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { count as drizzleCount, eq, type SQL } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import { getDb } from "@/db/postgres.db";
import { serviceLogger } from "@/utils";

export type DbClient = ReturnType<typeof getDb>;

export class RelationalRepository<T extends AnyPgTable & { id: any }> {
	private _model: T;
	private _explicitDb?: DbClient;

	/** @info - Utilities */
	private readonly log;

	constructor(model: T, db?: DbClient) {
		this._model = model;
		this._explicitDb = db;
		this.log = serviceLogger(this._model.constructor.name);
	}

	protected get _db(): DbClient {
		return this._explicitDb ?? getDb();
	}

	findById = async (id: number): Promise<InferSelectModel<T> | undefined> => {
		const [row] = await this._db
			.select()
			.from(this._model as any)
			.where(eq(this._model.id, id))
			.limit(1);
		return row as InferSelectModel<T> | undefined;
	};

	findOne = async (where: SQL): Promise<InferSelectModel<T> | undefined> => {
		const [row] = await this._db
			.select()
			.from(this._model as any)
			.where(where)
			.limit(1);
		return row as InferSelectModel<T> | undefined;
	};

	findMany = async (where?: SQL): Promise<InferSelectModel<T>[]> => {
		const query = this._db.select().from(this._model as any);
		if (where) query.where(where);
		return (await query) as InferSelectModel<T>[];
	};

	findPaginated = async (
		page: number,
		pageSize: number,
		where?: SQL,
	): Promise<{ data: InferSelectModel<T>[]; total: number }> => {
		const query = this._db.select().from(this._model as any);
		if (where) query.where(where);
		const data = (await query
			.limit(pageSize)
			.offset((page - 1) * pageSize)) as InferSelectModel<T>[];
		const [{ value }]: any = await this._db
			.select({ value: drizzleCount() })
			.from(this._model as any);
		return { data, total: value };
	};

	create = async (data: InferInsertModel<T>): Promise<InferSelectModel<T>> => {
		const [row] = await this._db
			.insert(this._model)
			.values(data as any)
			.returning();
		return row as InferSelectModel<T>;
	};

	createMany = async (
		data: InferInsertModel<T>[],
	): Promise<InferSelectModel<T>[]> => {
		const rows = await this._db
			.insert(this._model)
			.values(data as any)
			.returning();
		return rows as InferSelectModel<T>[];
	};

	update = async (
		id: number,
		data: Partial<InferInsertModel<T>>,
	): Promise<InferSelectModel<T> | undefined> => {
		const [row]: any = await this._db
			.update(this._model)
			.set(data as any)
			.where(eq(this._model.id, id))
			.returning();
		return row as InferSelectModel<T> | undefined;
	};

	updateWhere = async (
		where: SQL,
		data: Partial<InferInsertModel<T>>,
	): Promise<InferSelectModel<T>[]> => {
		const rows = await this._db
			.update(this._model)
			.set(data as any)
			.where(where)
			.returning();
		return rows as InferSelectModel<T>[];
	};

	upsert = async (
		where: SQL,
		data: InferInsertModel<T>,
	): Promise<InferSelectModel<T>> => {
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
	};

	delete = async (id: number): Promise<InferSelectModel<T> | undefined> => {
		const [row] = await this._db
			.delete(this._model)
			.where(eq(this._model.id, id))
			.returning();
		return row as InferSelectModel<T> | undefined;
	};

	deleteWhere = async (where: SQL): Promise<InferSelectModel<T>[]> => {
		const rows = await this._db.delete(this._model).where(where).returning();
		return rows as InferSelectModel<T>[];
	};

	count = async (where?: SQL): Promise<number> => {
		const query = this._db
			.select({ value: drizzleCount() })
			.from(this._model as any);

		const result = where ? query.where(where) : query;
		const [{ value }]: any = await result;
		return Number(value);
	};

	exists = async (where: SQL): Promise<boolean> => {
		const [row]: any = await this._db
			.select({ value: drizzleCount() })
			.from(this._model as any)
			.where(where)
			.limit(1);
		return row.value > 0;
	};

	transaction = async <R>(fn: (txRepo: this) => Promise<R>): Promise<R> => {
		return await this._db.transaction(async (tx) => {
			const txRepo = new (this.constructor as any)(this._model, tx);
			return fn(txRepo);
		});
	};

	getModel = () => this._model;
}
