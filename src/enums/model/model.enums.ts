export enum ModelCollections {
	ADMIN = "admin",
	USER = "user",

	USER_CREDENTIAL = "user_credential",

	BUSINESS = "business",

	CONNECTION = "connection",

	WHATSAPP_SESSION = "whatsapp_session",
	TELEGRAM_SESSION = "telegram_session",

	CONTACT = "contact",
	CONTACT_BUSINESS = "contact_business",

	MESSAGE = "message",

	BOT = "bot",
	AGENT = "agent",
	AGENT_VERSION = "agent_version",
	KNOWLEDGE_BASE = "knowledge_base",
	FLOW = "flow",

	LOCATION = "location",

	PRODUCT = "product",
	ORDER = "order",
	ORDER_ITEM = "order-item",
	ORDER_PAYMENT = "order-payment",
	PAYMENT = "payment",
	CART = "cart",
	CART_ITEM = "cart_item",

	REVIEW = "review",
	CATEGORY = "category",
	SUB_CATEGORY = "sub_category",
	TAG = "tag",

	PLAN = "plan",
	SUBSCRIPTION = "subscription",
	CREDIT_BALANCE = "credit_balance",
	CREDIT_TRANSACTION = "credit_transaction",
	USAGE_EVENT = "usage_event",
	PRICING_TIER = "pricing_tier",
}

export enum CoordinateEnums {
	LINE_STRING = "LineString",
	POINT = "Point",
	POLYGON = "Polygon",
}

// # Connection Enums
export enum ConnectionStatus {
	CONNECTED = "connected",
	PENDING = "pending",
	DISCONNECTED = "disconnected",
}

export enum ConnectionPlatform {
	WHATSAPP = "whatsapp",
	INSTAGRAM = "instagram",
	TELEGRAM = "telegram",
	WEB = "web",
}

// # Conversation Enums
export enum ConversationStatus {
	ACTIVE = "active",
	RESOLVED = "resolved",
	HANDED_OFF = "handed_off",
	ABANDONED = "abandoned",
}

export enum AuthMethod {
	EMAIL = "email",
	GOOGLE = "google",
	FACEBOOK = "facebook",
	APPLE = "apple",
}

/**
 * Platform-level user type.
 *
 * BUSINESS_OWNER / TEAM_MEMBER were removed — those are per-business
 * roles defined in BusinessMember.role, not identity-level traits.
 * A single user can be owner of Business A and viewer on Business B.
 */
export enum UserType {
	USER = "user",
	SUPER_ADMIN = "super_admin",
}

export enum BusinessRole {
	OWNER = "owner",
	ADMIN = "admin",
	MEMBER = "member",
	VIEWER = "viewer",
}

export enum Status {
	DRAFT = "draft",
	ACTIVE = "active",
	PAUSED = "paused",
	ARCHIVED = "archived",
	ERROR = "error",
	INACTIVE = "inactive",

	PROCESSING = "processing",
	READY = "ready",
	FAILED = "failed",
}

/**
 * Social/messaging channels a bot can be deployed to
 */
export enum Channel {
	WEB = "web",
	WHATSAPP = "whatsapp",
	TELEGRAM = "telegram",
	SLACK = "slack",
	DISCORD = "discord",
	SMS = "sms",
	EMAIL = "email",
	MESSENGER = "messenger",
	INSTAGRAM = "instagram",
}

export enum MessageRole {
	USER = "user",
	ASSISTANT = "assistant",
	SYSTEM = "system",
	TOOL = "tool",
}

export enum DocumentType {
	PDF = "pdf",
	TEXT = "text",
	MARKDOWN = "markdown",
	HTML = "html",
	URL = "url",
	NOTION = "notion",
	CONFLUENCE = "confluence",
	GOOGLE_DOCS = "google_docs",
}

export enum ToolStatus {
	ENABLED = "enabled",
	DISABLED = "disabled",
	TESTING = "testing",
	DEPRECATED = "deprecated",
}

/**
 * Flow node types are defined by the FlowNodeConfig discriminated union.
 * No separate enum needed — config.type IS the type.
 */

export enum HandoffReason {
	USER_REQUEST = "user_request",
	SENTIMENT_NEGATIVE = "sentiment_negative",
	CONFIDENCE_LOW = "confidence_low",
	ESCALATION_RULE = "escalation_rule",
	BUSINESS_HOURS = "business_hours",
	AGENT_ERROR = "agent_error",
}

export enum PlanType {
	FREE = "free",
	STARTER = "starter",
	PROFESSIONAL = "professional",
	ENTERPRISE = "enterprise",
}

export enum AttachmentTypes {
	IMAGE = "image",
	FILE = "file",
	AUDIO = "audio",
	VIDEO = "video",
}

export enum MessageSenderTypes {
	CONTACT = ModelCollections.CONTACT,
	BOT = ModelCollections.BOT,
	HUMAN_AGENT = ModelCollections.USER,
}
