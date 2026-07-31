import type { Document, Types } from "mongoose";
import type { BotHandoffSensitivity, BotWebTheme, Status } from "@/enums";

/**
 * Bot — A deployed instance of an agent on a specific channel
 *
 * BotConfig merged in as `channelConfig` subdocument.
 * 1:1 separation had no modeling benefit — token isolation
 * is an encryption concern, not a schema concern.
 */
export interface IBot extends Document<Types.ObjectId> {
	// Ownership
	businessId: Types.ObjectId; // ref → Business.id

	// Config
	name: string;
	description?: string;
	agentId: Types.ObjectId; // ref → Agent.id
	channelId?: Types.ObjectId; // ref → Channel.id (set on deployment)

	// Appearance (web widget / embeds)
	primaryColor?: string;
	theme?: BotWebTheme;
	identifier?: string; // UUID-v4

	// Messages
	welcomeMessage: string;
	fallbackMessage: string;

	// Business hours
	enableBusinessHours: boolean;
	businessHours?: {
		timezone: string;
		schedule: Partial<
			Record<
				| "monday"
				| "tuesday"
				| "wednesday"
				| "thursday"
				| "friday"
				| "saturday"
				| "sunday",
				{ start: string; end: string }
			>
		>;
		outOfHoursMessage?: string;
	};

	// Human handoff
	enableHandoff: boolean;
	handoffRules: {
		keywords?: string[];
		allowUserRequest?: boolean;
		sensitivity?: BotHandoffSensitivity;
	};

	// Status
	status: Status;
	isActive: boolean;

	// Metadata
	createdAt: Date;
	updatedAt: Date;
	lastMessageAt?: Date;
}
