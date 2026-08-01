import { and, eq } from "drizzle-orm";
import { RelationalRepository } from "@/bases";
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
}
