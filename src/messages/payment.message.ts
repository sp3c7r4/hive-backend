import type { PlanName } from "@/enums";

export const PaymentMessage = {
	WEBHOOK_SUCCESS: "Webhook processed successfully",
};

export const CreditBalanceMessages = {
	NOT_FOUND: "Credit balance record not found",
};

export const SubscriptionMessages = {
	CREDIT_TRANSACTION: (planName: PlanName) => {
		return `${planName[0]?.toUpperCase() + planName.slice(1)} subscription`;
	},
	NOT_FOUND: "Subscription not found.",
	CANNOT_SUB_FREE: "Free Subscription isn't allowed.",
};
