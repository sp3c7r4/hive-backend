import { PaymentCurrency } from "@/enums";

const CURRENCY_CONFIG = {
	[PaymentCurrency.NGN]: { divisor: 100, symbol: "₦", locale: "en-NG" },
	[PaymentCurrency.USD]: { divisor: 100, symbol: "$", locale: "en-US" },
} as const;

/**
 * Convert least unit to major unit
 * e.g. 150000 kobo → 1500.00
 *      1099 cents → 10.99
 */
export function toMajorUnit(amount: number, currency: PaymentCurrency): number {
	return amount / CURRENCY_CONFIG[currency].divisor;
}

/**
 * Convert major unit back to least unit for storage
 * e.g. 1500 → 150000 kobo
 *      10.99 → 1099 cents
 */
export function toLeastUnit(amount: number, currency: PaymentCurrency): number {
	return Math.round(amount * CURRENCY_CONFIG[currency].divisor);
}

/**
 * Format least unit amount into display string
 * e.g. 150000, "ngn" → "₦1,500.00"
 *      1099, "usd"   → "$10.99"
 */
export function formatCurrency(
	amount: number,
	currency: PaymentCurrency,
): string {
	const { locale } = CURRENCY_CONFIG[currency];
	return new Intl.NumberFormat(locale, {
		style: "currency",
		currency: currency.toUpperCase(),
		minimumFractionDigits: 2,
	}).format(toMajorUnit(amount, currency));
}
