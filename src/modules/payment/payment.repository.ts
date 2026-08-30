import { desc, eq } from "drizzle-orm";
import { RelationalRepository } from "@/bases";
import { getDb } from "@/db/postgres.db";
import { payments } from "./payment.model";

export class PaymentRepository extends RelationalRepository<typeof payments> {
	private static instance: PaymentRepository;

	static getInstance(): PaymentRepository {
		if (!this.instance) this.instance = new PaymentRepository();
		return this.instance;
	}

	private constructor() {
		super(payments);
	}

	findByReference = async (reference: string) => {
		return this.findOne(eq(payments.reference, reference));
	};

	listByPayer = async (payerId: number) => {
		const db = getDb();
		return db
			.select()
			.from(payments)
			.where(eq(payments.payerId, payerId))
			.orderBy(desc(payments.createdAt))
			.limit(50);
	};
}
