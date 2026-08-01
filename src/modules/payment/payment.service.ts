import { eq } from "drizzle-orm";
import { PaymentStatus } from "@/enums";
import { serviceLogger } from "@/utils";

// TODO: Import your actual payment table and repository
// import { payment } from "@/models";
// import { PaymentRepository } from "@/repositories";

export class PaymentService {
	private static instance: PaymentService;

	/** @info - Utilities */
	private log = serviceLogger("Payment Service");

	static getInstance(): PaymentService {
		if (!this.instance) this.instance = new PaymentService();
		return this.instance;
	}

	private constructor() {}

	cancelPayment = async (trackingCode: string) => {
		try {
			// TODO: Implement with your actual payment repository
			// await this.paymentRepo.updateWhere(
			// 	eq(payment.trackingCode, trackingCode),
			// 	{ status: PaymentStatus.CANCELLED },
			// );
			this.log.info(`Payment cancelled: ${trackingCode}`);
		} catch (e) {
			this.log.error("Error canceling payment.", { error: e });
			return;
		}
	};
}
