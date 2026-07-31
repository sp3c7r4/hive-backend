import { Templates, type GenerateReceiptOptions } from "@/enums";
import { FileGenerator } from "./engine/browser.engine";

function formatAmount(amount: number): string {
	return amount.toLocaleString(undefined, {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
}

export class ReceiptGenerator extends FileGenerator<GenerateReceiptOptions> {
	private static instance: ReceiptGenerator;

	// Expects templates/receipts/receipt/html.hbs (bundled) or
	// src/receipts/receipt/html.hbs (dev) — matches the emails/<name>/html.hbs
	// layout the base class already assumes, just under "receipts" instead.
	protected readonly templatesFolder = "templates";

	private constructor() {
		super();
	}

	static getInstance(): ReceiptGenerator {
		if (!this.instance) this.instance = new ReceiptGenerator();
		return this.instance;
	}

	protected async buildHtml(options: GenerateReceiptOptions): Promise<string> {
		const currencySymbol = options.currencySymbol ?? "$";

		const rawProducts = options.products.map((p, i) => ({
			index: i + 1,
			description: p.description,
			quantity: p.quantity,
			total: p.quantity * p.unitPrice,
			unitPriceRaw: p.unitPrice,
		}));

		const subTotalRaw = rawProducts.reduce((sum, p) => sum + p.total, 0);
		const taxRaw =
			options.taxAmount !== undefined
				? options.taxAmount
				: subTotalRaw * (options.taxRate ?? 0);
		const totalRaw = subTotalRaw + taxRaw;

		const products = rawProducts.map((p) => ({
			index: p.index,
			description: p.description,
			quantity: p.quantity,
			unitPrice: formatAmount(p.unitPriceRaw),
			total: formatAmount(p.total),
		}));

		// Uses the base class's fallbackLogo (config.server.logo.dark) rather
		// than a locally hardcoded constant, so it stays in sync with
		// whatever every other generator falls back to.
		const logoUrl = options.business.logoUrl?.trim() || this.fallbackLogo;

		const source = await this.getTemplate(Templates.RECEIPT);

		return this.compile(source, {
			receiptNumber: options.receiptNumber,
			receiptDate: options.receiptDate,
			business: options.business,
			logoUrl,
			customer: options.customer,
			products,
			note: options.note,
			subTotal: formatAmount(subTotalRaw),
			tax: formatAmount(taxRaw),
			total: formatAmount(totalRaw),
			currencySymbol,
		});
	}
}
