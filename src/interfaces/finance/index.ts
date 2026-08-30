export interface InitializeTransactionOptions {
	email: string;
	amount: number; // keep in base unit (kobo, cents — caller's responsibility)
	callbackUrl?: string;
	callback_url?: string;
	cancel_action?: string;
	currency?: string;
	metadata?: Record<string, unknown>;
	priceId?: string; // Stripe-specific, optional
}

export interface VerifyTransactionOptions {
	reference: string;
}

export interface HandleWebhookOptions {
	paystack_signature: string;
	body: Record<string, any>;
	/** @info - Raw request body — used for HMAC verification (Paystack signs the raw bytes) */
	rawBody?: string;
}

export interface InitializeTransactionResult {
	data: {
		authorization_url: string;
		access_code: string;
		reference: string;
	};
}

export interface VerifyTransactionResult {
	data: {
		status: string;
		reference: string;
		amount: number;
	};
}
