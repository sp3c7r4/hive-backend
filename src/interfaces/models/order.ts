import type { Document, Types } from "mongoose";
import type { OrderStatus } from "@/enums";

export interface IOrder extends Document<Types.ObjectId> {
	status: OrderStatus;
	totalAmount: number;
	products: Types.ObjectId[];

	deliveryMethod: "pickup" | "delivery";
	pickupLocationId: Types.ObjectId;
	deliveryLocationId: Types.ObjectId;
	customerId: Types.ObjectId;
	merchantId: Types.ObjectId;
	paymentId: Types.ObjectId;
}
