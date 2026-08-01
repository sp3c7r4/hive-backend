import { PaymentServiceProvider } from "@/enums";
import { PaystackService } from "./paystack.service";

export class PaymentFactoryService {
	private static instance: PaymentFactoryService;

	/** @info - Services */
	private paystack: PaystackService;

	static getInstance(): PaymentFactoryService {
		if (!this.instance) this.instance = new PaymentFactoryService();
		return this.instance;
	}

	private constructor() {
		this.paystack = PaystackService.getInstance();
	}

  get = (serviceProvider: PaymentServiceProvider) => {
    switch (serviceProvider) {
      case PaymentServiceProvider.PAYSTACK:
        return this.paystack;
      default:
        throw new Error(`Invalid Payment Provider: ${serviceProvider}`);
    }
  };
}
