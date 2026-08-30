import {
	index,
	integer,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { users } from "@/modules/user/user.model";
import { courses } from "@/modules/courses/course.model";
import { userRoleEnum } from "@/bases/models/base.user.model";
import { enrollments } from "@/modules/enrollments/enrollment.model";
import { communities } from "@/modules/communities/community.model";
import {
	PaymentTransactionStatus,
	PaymentTransactionType,
	PaymentTransactionMethod,
	WithdrawalStatus,
	TableNames,
} from "@/enums";
import { timestamps } from "@/models/timestamps.b.model";

export const paymentStatusEnum = pgEnum("payment_status", Object.values(PaymentTransactionStatus) as [string, ...string[]]);
export const paymentTypeEnum = pgEnum("payment_type", Object.values(PaymentTransactionType) as [string, ...string[]]);
export const paymentMethodEnum = pgEnum("payment_method", Object.values(PaymentTransactionMethod) as [string, ...string[]]);
export const withdrawalStatusEnum = pgEnum("withdrawal_status", Object.values(WithdrawalStatus) as [string, ...string[]]);

/**
 * @info - Payment record. payerId points to users.id.
 *         payerRole provides context (student / parent) without a polymorphic FK.
 */
export const payments = pgTable(
	TableNames.PAYMENTS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		payerId: integer("payer_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		/** @info - Role context for the payer (student / parent) */
		payerRole: userRoleEnum("payer_role").notNull(),
		enrollmentId: integer("enrollment_id")
			.references(() => enrollments.id, { onDelete: "set null" }),
		/** @info - Course being purchased (available before enrollment exists) */
		courseId: integer("course_id")
			.references(() => courses.id, { onDelete: "set null" }),
		communityId: integer("community_id")
			.references(() => communities.id, { onDelete: "set null" }),
		amount: integer("amount").notNull(),
		platformFee: integer("platform_fee").default(0),
		status: paymentStatusEnum("status").default("pending").notNull(),
		method: paymentMethodEnum("method").default("paystack").notNull(),
		reference: varchar("reference", { length: 255 }).notNull(),
		type: paymentTypeEnum("type").notNull(),
		description: text("description"),
		studentId: integer("student_id")
			.references(() => users.id, { onDelete: "set null" }),
		receiptUrl: varchar("receipt_url", { length: 1000 }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("uq_payments_reference").on(table.reference),
		index("idx_payments_payer").on(table.payerId),
		index("idx_payments_enrollment").on(table.enrollmentId),
		index("idx_payments_course").on(table.courseId),
		index("idx_payments_status").on(table.status),
		index("idx_payments_student").on(table.studentId),
	],
);

/** @info - Instructor withdrawal request */
export const withdrawals = pgTable(
	TableNames.WITHDRAWALS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		instructorId: integer("instructor_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		amount: integer("amount").notNull(),
		bankName: varchar("bank_name", { length: 255 }).notNull(),
		accountNumber: varchar("account_number", { length: 20 }).notNull(),
		accountName: varchar("account_name", { length: 255 }).notNull(),
		status: withdrawalStatusEnum("status").default("pending").notNull(),
		reference: varchar("reference", { length: 255 }).notNull(),
		requestedAt: timestamp("requested_at").defaultNow().notNull(),
		processedAt: timestamp("processed_at"),
		...timestamps,
	},
	(table) => [
		uniqueIndex("uq_withdrawals_reference").on(table.reference),
		index("idx_withdrawals_instructor").on(table.instructorId),
		index("idx_withdrawals_status").on(table.status),
	],
);

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
export type Withdrawal = typeof withdrawals.$inferSelect;
export type NewWithdrawal = typeof withdrawals.$inferInsert;

/** @info - Relations */
export const paymentsRelations = relations(payments, ({ one }) => ({
	payer: one(users, {
		fields: [payments.payerId],
		references: [users.id],
	}),
	enrollment: one(enrollments, {
		fields: [payments.enrollmentId],
		references: [enrollments.id],
	}),
	community: one(communities, {
		fields: [payments.communityId],
		references: [communities.id],
	}),
	student: one(users, {
		fields: [payments.studentId],
		references: [users.id],
	}),
}));

export const withdrawalsRelations = relations(withdrawals, ({ one }) => ({
	instructor: one(users, {
		fields: [withdrawals.instructorId],
		references: [users.id],
	}),
}));
