import { eq } from "drizzle-orm";
import { PaymentStatus } from "@/enums";
import { payment } from "@/models";
import { PaymentRepository } from "@/repositories";
import { serviceLogger } from "@/utils";

export class PaymentService {
	private static instance: PaymentService;

	/** @info - Repositories */
	private paymentRepo: PaymentRepository;

	/** @info - Utilities */
	private log = serviceLogger("Payment Service");

	static getInstance(): PaymentService {
		if (!this.instance) this.instance = new PaymentService();
		return this.instance;
	}

	private constructor() {
		this.paymentRepo = PaymentRepository.getInstance();
	}

	cancelPayment = async (trackingCode: string) => {
		try {
			await this.paymentRepo.updateWhere(
				eq(payment.trackingCode, trackingCode),
				{
					status: PaymentStatus.CANCELLED,
				},
			);
		} catch (e) {
			this.log.error("Error canceling payment.", { error: e });
			return;
		}
	};
}
