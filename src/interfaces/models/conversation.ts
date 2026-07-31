// ============================================================================
// SHARED TYPES
// ============================================================================

import type { AttachmentTypes } from "@/enums";

/**
 * LLM parameter tuning knobs — embedded wherever config is needed.
 * Replaces the old standalone AgentParameter entity.
 */
export enum AgentStyle {
	Precise = "precise",
	Balanced = "balanced",
	Creative = "creative",
}

export interface LLMParameters {
	creativity: number; // 0–1, maps to temperature internally
	maxResponseLength: number; // maps to maxTokens
	style: AgentStyle; // maps to topP/topK internally
}

/**
 * Attachment on a message (images, files, audio, video)
 */

export interface Attachment {
	type: AttachmentTypes;
	url: string;
	mimeType: string;
	size: number; // bytes
}

/**
 * Tool/function call made during a message
 */
export interface ToolCall {
	id: string;
	name: string;
	arguments: string; // JSON string
	response?: string;
	latency?: number; // ms
	success: boolean;
}
