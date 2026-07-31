export enum AgentModel {
	ZEUS = "us.anthropic.claude-haiku-4-5-20251001-v1:0",
	ATHENA = "us.anthropic.claude-haiku-4-5-20251001-v1:0",
}

export enum AgentTools {
	GET_PRODUCTS = "get_products",
	GET_PRODUCT_DETAILS = "get_product_details",
	FIND_PRODUCT = "find_product",
	GET_CART = "get_cart",
	MODIFY_CART_ITEM = "modify_cart_item",
	CLEAR_CART = "clear_cart",

	PLACE_ORDER = "place_order",
	CHECK_ORDER_STATUS = "check_order_status",
	CANCEL_ORDER = "cancel_order",

	/** @info - This is collected to onboard the user as a contact Business - like collecting their
	 * name, email, phone, deliveryAddress, avatar, displayName(userName)
	 **/
	ONBOARD = "onboard",
}
