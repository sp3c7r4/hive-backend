export enum PaystackEvents {
	/* A successful charge was made  */
	CHARGE_SUCCESS = "charge.success",

	TRANSFER_FAILED = "transfer.failed",
	TRANSFER_SUCCESS = "transfer.success",
	TRANSFER_REVERSED = "transfer.reversed",

	CUSTOMER_IDENTIFICATION_FAILED = "customeridentification.failed",
	CUSTOMER_IDENTIFICATION_SUCCESS = "customeridentification.success",
}

export enum PaystackVerifyStatus {
	ABANDONED = "abandoned",
	SUCCESS = "success",
	ONGOING = "ongoing",
	PENDING = "pending",
	REVERSED = "reversed",
}

/* Web Apis */
export interface PaystackPaths {
	VERIFY_URL: `/transaction/verify/${string}`;
	INITIALIZE_TRANSACTION: "/transaction/initialize";
	CREATE_CHARGE: "/charge";
	TRANSFER_RECIPIENT: "/transferrecipient";
	TRANSFER: "/transfer";
	BANKS: "/bank";
	BANK_RESOLVE: "/bank/resolve";
}
