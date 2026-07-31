import type { Document, Types } from "mongoose";
import type { AgentModel, Status } from "@/enums";
import type { LLMParameters } from "./conversation";

/**
 * Agent — The AI brain that powers bots
 */
export interface IAgent extends Document<Types.ObjectId> {
	// Identity
	name: string;
	description?: string;
	status: Status.ACTIVE | Status.INACTIVE;

	avatar?: string;

	// Ownership
	businessId: Types.ObjectId; // ref → Business._id

	currentAgentVersionId?: Types.ObjectId; // ref → AgentVersion._id
	// Flow reference
	// activeFlowId?: string; // ref → Flow._id
	// Metadata
	createdAt: Date;
	updatedAt: Date;
	lastTestedAt?: Date;
	tags: string[];
}

/**
 * AgentVersion — Immutable snapshot of agent config
 *
 * Parameters are embedded directly (no separate AgentParameter entity).
 * Each version is a complete, self-contained record of the agent's state.
 */
export interface IAgentVersion extends Document<Types.ObjectId> {
	agentId: Types.ObjectId; // ref → Agent._id
	version: number; // auto-incrementing version number
	// Full config snapshot
	systemPrompt: string;
	llmModel: AgentModel;

	parameters: LLMParameters;
	// Context snapshot (frozen at version creation time)
	enableRAG: boolean;
	knowledgeBaseIds: Types.ObjectId[]; // snapshot of bound KB IDs at this version
	flowId?: Types.ObjectId; // ref → Flow._id
	// Tracking
	createdBy?: Types.ObjectId; // ref → User._id
	createdAt: Date;
}

/**
 * AgentKnowledgeBase — Junction: Agent ↔ KnowledgeBase (many-to-many)
 *
 * Live relationship for runtime KB lookups.
 * AgentVersion.knowledgeBaseIds is a frozen snapshot at version creation time.
 */
export interface IKnowledgeBase extends Document<Types.ObjectId> {
	name: string;
	status: Status.PROCESSING | Status.READY | Status.FAILED;
	businessId: Types.ObjectId;
	isEnabled: boolean;
	priority?: number; // retrieval priority when multiple KBs are bound

	vector: number[];
	metadata: {
		data: string;
	};
	createdAt: Date;
}
