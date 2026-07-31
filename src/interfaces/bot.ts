import type { BotWsEventTypes } from "@/enums";

export interface BotConfig {
	name: string;
	description?: string;
}

export type BotWsEvents =
	| { type: BotWsEventTypes.SEND; text: string }
	| { type: BotWsEventTypes.UPDATE; text: string; messageId: string }
	| { type: BotWsEventTypes.DELETE; messageId: string };
