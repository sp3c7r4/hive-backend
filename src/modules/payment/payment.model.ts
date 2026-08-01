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
import { students } from "@/modules/student/student.model";
import { enrollments } from "@/modules/enrollments/enrollment.model";
import { communities } from "@/modules/communities/community.model";
import { instructors } from "@/modules/instructor/instructor.model";
import {
	PaymentTransactionStatus,
	PaymentTransactionType,
	PaymentTransactionMethod,
	WithdrawalStatus,
	UserRole,
	TableNames,
} from "@/enums";
import { timestamps } from "@/models/timestamps.b.model";

const paymentStatusEnum = pgEnum("payment_status", Object.values(PaymentTransactionStatus) as [string, ...string[]]);
const paymentTypeEnum = pgEnum("payment_type", Object.values(PaymentTransactionType) as [string, ...string[]]);
const paymentMethodEnum = pgEnum("payment_method", Object.values(PaymentTransactionMethod) as [string, ...string[]]);
const withdrawalStatusEnum = pgEnum("withdrawal_status", Object.values(WithdrawalStatus) as [string, ...string[]]);
const userRoleEnum = pgEnum("user_role", Object.values(UserRole) as [string, ...string[]]);

/**
 * @info - Payment record.
 *         payerId + payerType is polymorphic — payer can be a student or parent.
 *         studentId is the child beneficiary when a parent pays.
 */
export const payments = pgTable(
	TableNames.PAYMENTS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		/** @info - ID of the payer in their role table */
		payerId: integer("payer_id").notNull(),
		/** @info - Which role table payerId refers to (student / parent) */
		payerType: userRoleEnum("payer_type").notNull(),
		enrollmentId: integer("enrollment_id")
			.references(() => enrollments.id, { onDelete: "set null" }),
		communityId: integer("community_id")
			.references(() => communities.id, { onDelete: "set null" }),
		/** @info - Amount in kobo */
		amount: integer("amount").notNull(),
		/** @info - Platform fee in kobo, 10% of amount */
		platformFee: integer("platform_fee").default(0),
		status: paymentStatusEnum("status").default("pending").notNull(),
		method: paymentMethodEnum("method").default("paystack").notNull(),
		reference: varchar("reference", { length: 255 }).notNull(),
		type: paymentTypeEnum("type").notNull(),
		description: text("description"),
		/** @info - Child beneficiary when a parent pays for a student's course */
		studentId: integer("student_id")
			.references(() => students.id, { onDelete: "set null" }),
		receiptUrl: varchar("receipt_url", { length: 1000 }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("uq_payments_reference").on(table.reference),
		index("idx_payments_payer").on(table.payerId, table.payerType),
		index("idx_payments_enrollment").on(table.enrollmentId),
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
			.references(() => instructors.id, { onDelete: "restrict" }),
		/** @info - Amount in kobo */
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
	enrollment: one(enrollments, {
		fields: [payments.enrollmentId],
		references: [enrollments.id],
	}),
	community: one(communities, {
		fields: [payments.communityId],
		references: [communities.id],
	}),
	student: one(students, {
		fields: [payments.studentId],
		references: [students.id],
	}),
}));

export const withdrawalsRelations = relations(withdrawals, ({ one }) => ({
	instructor: one(instructors, {
		fields: [withdrawals.instructorId],
		references: [instructors.id],
	}),
}));
