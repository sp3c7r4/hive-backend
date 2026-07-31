import { type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { DbClient } from "@/bases";
import { getDb } from "@/db/postgres.db";
/**
 * Executes a callback within a database transaction.
 *
 * @template T
 * @param {(tx: unknown) => Promise<T>} fn - Async callback that receives the transaction instance.
 * @returns {Promise<T>} Resolves with the callback result if the transaction succeeds.
 *
 * @example
 * await withTransaction(async (tx) => {
 *   const userRepo = new RelationalRepository(user, tx);
 *   const walletRepo = new RelationalRepository(wallet, tx);
 *
 *   await userRepo.create({ ... });
 *   await walletRepo.create({ ... });
 *
 *   // Both operations roll back together if either fails
 * });
 */
export const withTransaction = async <R>(
	fn: (tx: DbClient) => Promise<R>,
): Promise<R> => {
	return await getDb().transaction(fn as any);
};

export const jsonbField = (column: PgColumn, key: string): SQL =>
	sql`${column}->>${key}`;

export function isUniqueConstraintError(
	err: unknown,
	column?: string,
): boolean {
	if (!err || typeof err !== "object") return false;

	const e = err as {
		code?: string;
		message?: string;
		constraint?: string;
		errno?: number;
	};

	// Postgres (node-postgres / postgres.js / neon)
	if (e.code === "23505") {
		return column ? (e.constraint?.includes(column) ?? true) : true;
	}

	// MySQL (mysql2)
	if (e.code === "ER_DUP_ENTRY" || e.errno === 1062) {
		return column ? (e.message?.includes(column) ?? true) : true;
	}

	// SQLite (better-sqlite3 / libsql)
	if (
		e.code === "SQLITE_CONSTRAINT_UNIQUE" ||
		e.message?.includes("UNIQUE constraint failed")
	) {
		return column ? (e.message?.includes(column) ?? true) : true;
	}

	return false;
}
