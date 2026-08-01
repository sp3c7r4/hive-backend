export enum EmailTemplates {
	RESET_PASSWORD = "reset-password",
	VERIFY_OTP = "verify-otp",
	WELCOME = "welcome",
	RECEIPT = "receipt",
}

export enum Templates {
	RECEIPT = "receipt",
}

export interface ReceiptBusiness {
	name: string;
	email?: string;
	address?: string;
	logoUrl?: string;
}

export interface ReceiptCustomer {
	name: string;
	address?: string;
}

export interface ReceiptProductInput {
	description: string;
	quantity: number;
	unitPrice: number;
}

export interface GenerateReceiptOptions {
	receiptNumber: string;
	receiptDate: string;
	business: ReceiptBusiness;
	customer: ReceiptCustomer;
	products: ReceiptProductInput[];
	note?: string;
	taxRate?: number;
	taxAmount?: number;
	currencySymbol?: string;
	connectionId?: number;
	senderId?: string;
}
