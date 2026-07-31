export enum PlanName {
	FREE = "free",
	STARTER = "starter",
	GROWTH = "growth",
	ENTERPRISE = "enterprise",
}

export enum PlanBillingInterval {
	MONTHLY = "monthly",
	YEARLY = "yearly",
	NONE = "no-billing",
}

export enum PlanSubscriptionStatus {
	ACTIVE = "active",
	PAST_DUE = "past_due",
	CANCELLED = "cancelled",
}

export enum CreditTransactionType {
	PLAN_RENEWAL = "plan_renewal",
	TOPUP = "topup",
	USAGE = "usage",
	REFUND = "refund",
	ADJUSTMENT = "adjustment",
	OVERAGE = "overage",
}

export enum CreditTransactionRefrenceType {
	PAYMENT = "payment",
	USAGE_EVENT = "usage_event",
	SUBSCRIPTION = "subscription",
}

export enum PricingTierActionName {
	BOT_RESPONSE = "bot_response",
}

export * from "./payment";
export * from "./paystack";
