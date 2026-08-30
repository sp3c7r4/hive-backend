import { integer, pgEnum, pgTable, uniqueIndex, varchar, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import {
	LedgerTransactionCategory,
	LedgerTransactionType,
	TableNames,
} from "@/enums";
import { users } from "@/modules/user/user.model";
import { payments, withdrawals } from "./payment.model";
import { timestamps } from "@/models/timestamps.b.model";

/** @info - Instructor earnings balance per user (M1) */
export const instructorBalance = pgTable(TableNames.INSTRUCTOR_BALANCES, {
	id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
	instructorId: integer("instructor_id")
		.notNull()
		.references(() => users.id, { onDelete: "restrict" }),
	/** @info - Net earnings minus holds/withdrawn (kobo) */
	available: integer("available").default(0).notNull(),
	/** @info - Lifetime paid out (kobo) */
	withdrawn: integer("withdrawn").default(0).notNull(),
	...timestamps,
}, (table) => [
	uniqueIndex("uq_instructor_balance").on(table.instructorId),
	index("idx_instructor_balances_instructor").on(table.instructorId),
]);

/** @info - Append-only ledger. Balance = last row's balanceAfter. */
export const instructorTransaction = pgTable(TableNames.INSTRUCTOR_TRANSACTIONS, {
	id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
	instructorId: integer("instructor_id")
		.notNull()
		.references(() => users.id, { onDelete: "restrict" }),
	type: pgEnum("instructor_tx_type", Object.values(LedgerTransactionType) as [string, ...string[]])("type").notNull(),
	category: pgEnum("instructor_tx_category", Object.values(LedgerTransactionCategory) as [string, ...string[]])("category").notNull(),
	/** @info - Positive magnitude (kobo) */
	amount: integer("amount").notNull(),
	balanceAfter: integer("balance_after").notNull(),
	/** @info - payment.reference or withdrawal.reference (idempotency key) */
	reference: varchar("reference", { length: 255 }).notNull(),
	paymentId: integer("payment_id").references(() => payments.id, { onDelete: "set null" }),
	withdrawalId: integer("withdrawal_id").references(() => withdrawals.id, { onDelete: "set null" }),
	description: varchar("description", { length: 255 }),
	...timestamps,
}, (table) => [
	/** @info - (reference, category) unique: withdrawal debit + its refund share the reference */
	uniqueIndex("uq_instructor_tx_ref_category").on(table.reference, table.category),
	index("idx_instructor_tx_instructor").on(table.instructorId),
]);

export const instructorBalanceRelations = relations(instructorBalance, ({ one }) => ({
	instructor: one(users, {
		fields: [instructorBalance.instructorId],
		references: [users.id],
	}),
}));

export const instructorTransactionRelations = relations(instructorTransaction, ({ one }) => ({
	instructor: one(users, {
		fields: [instructorTransaction.instructorId],
		references: [users.id],
	}),
	payment: one(payments, {
		fields: [instructorTransaction.paymentId],
		references: [payments.id],
	}),
	withdrawal: one(withdrawals, {
		fields: [instructorTransaction.withdrawalId],
		references: [withdrawals.id],
	}),
}));

export type InstructorBalance = typeof instructorBalance.$inferSelect;
export type NewInstructorBalance = typeof instructorBalance.$inferInsert;
export type InstructorTransaction = typeof instructorTransaction.$inferSelect;
export type NewInstructorTransaction = typeof instructorTransaction.$inferInsert;
