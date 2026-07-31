import { generateText } from "ai";
import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { BaseWorkerService, RelationalRepository } from "@/bases";
import {
	BotFallBackMessages,
	BotWsEventTypes,
	ConnectionPlatform,
	MessageRole,
	MessageSenderTypes,
	PricingTierActionName,
	Status,
	WebQueueNames,
} from "@/enums";
import { getAgentById, getLatestMessages, PlanHandler } from "@/helpers";
import type { AgentStyle } from "@/interfaces";
import {
	type AgentVersion,
	agentVersion,
	knowledgeBase,
} from "@/modules/agent/models";
import { BotRepository } from "@/modules/bot/bot.repository";
import { ContactService } from "@/modules/contact/contact.service";
import { ConversationService } from "@/modules/conversation/conversation.service";
import { AiService, AiToolService } from "@/services/ai.service";
import { PublisherService } from "@/services/notification";
import { serviceLogger } from "@/utils";

interface AiInfoParams {
	systemPrompt: string;
	agentName?: string;
	agentDescription?: string;
	agentTags?: string[];
	style?: AgentStyle;
	knowledgeBase?: string;
	maxResponseLength?: number;
}

const STYLE_MAP: Record<string, string> = {
	precise: "precise, factual, and structured",
	balanced: "clear, helpful, and conversational",
	creative: "creative, engaging, and expressive",
};

export class WebMessageWorkerService extends BaseWorkerService {
	private static instance: WebMessageWorkerService;

	private readonly aiService: AiService;
	private readonly conversationService: ConversationService;
	private readonly contactService: ContactService;
	private readonly publisherService: PublisherService;
	private readonly toolService: AiToolService;

	private readonly botRepository = BotRepository.getInstance();
	private readonly knowledgeBaseRepository = new RelationalRepository(
		knowledgeBase,
	);
	private readonly agentVersionRepository = new RelationalRepository(
		agentVersion,
	);

	private readonly log = serviceLogger("Web Message Worker Service");
	private readonly planHandler = PlanHandler.getInstance();

	static getInstance() {
		if (!this.instance) this.instance = new WebMessageWorkerService();
		return this.instance;
	}

	private constructor() {
		super({
			queueName: WebQueueNames.MESSAGES,
			alias: "WebMessageWorker",
			concurrency: 10,
		});
		this.aiService = AiService.getInstance();
		this.conversationService = ConversationService.getInstance();
		this.contactService = ContactService.getInstance();
		this.publisherService = PublisherService.getInstance();
		this.toolService = AiToolService.getInstance();
	}

	private buildAgentPrompt = (params: AiInfoParams) => {
		const name = params.agentName || "Nova";
		const description = params.agentDescription || "A helpful AI assistant.";
		const tags = params.agentTags?.length ? params.agentTags.join(", ") : "";
		const style = STYLE_MAP[params.style ?? ""] ?? "clear and helpful";
		const kb = params.knowledgeBase || "";
		const maxResponseLength = params.maxResponseLength;

		const parts: string[] = [
			params.systemPrompt,
			"",
			`You are ${name}${description ? ` — ${description}` : ""}.`,
		];

		if (tags) parts.push(`\nYour areas of expertise: ${tags}.`);

		parts.push(
			"",
			"## Response Guidelines",
			"",
			`- Respond in a ${style} manner.`,
			"- Stay strictly within your defined role and knowledge. If a question falls outside your scope, say so honestly.",
			"- Do not fabricate information. If you are unsure, acknowledge the limitation.",
			"- Keep responses focused and relevant to the user's query.",
		);

		if (maxResponseLength)
			parts.push(
				`- Limit your response to a maximum of ${maxResponseLength} tokens.`,
			);

		if (kb) {
			parts.push(
				"",
				"## Knowledge Base",
				"",
				"Use the following reference material to inform your answers. Treat it as your primary source of truth and prefer it over general knowledge when relevant.",
				"",
				"<knowledge_base>",
				kb,
				"</knowledge_base>",
			);
		}

		return parts.join("\n");
	};

	protected async process(job: Job) {
		const { type, replyChannel, botId, sessionId, text, messageId } = job.data;

		switch (type) {
			case BotWsEventTypes.SEND:
				await this.handleSend({ botId, sessionId, text, replyChannel });
				break;
			case BotWsEventTypes.UPDATE:
				await this.handleUpdate({ messageId, text, replyChannel });
				break;
			case BotWsEventTypes.DELETE:
				await this.handleDelete({ messageId, replyChannel });
				break;
			default:
				this.log.warn(`Unknown job type: ${type}`);
		}
	}

	private async handleSend(params: {
		botId: number;
		sessionId: string;
		text: string;
		replyChannel: string;
	}) {
		const { botId, sessionId, text, replyChannel } = params;

		const foundBot = await this.botRepository.findById(botId);
		if (!foundBot) {
			this.log.error(`Bot not found: ${botId}`);
			return await this.publisherService.publish(
				replyChannel,
				"ERROR",
				JSON.stringify({ error: BotFallBackMessages.BOT_NOT_AVAILABLE }),
			);
		}

		if (!foundBot.channelId) {
			this.log.error(`Bot [${foundBot.id}] is not deployed to any channel`);
			return await this.publisherService.publish(
				replyChannel,
				"ERROR",
				JSON.stringify({ error: BotFallBackMessages.BOT_NOT_AVAILABLE }),
			);
		}

		if (foundBot.status === Status.PAUSED || !foundBot.isActive) {
			this.log.error(`Bot [${foundBot.id}] is not active`);
			return await this.publisherService.publish(
				replyChannel,
				"ERROR",
				JSON.stringify({ error: BotFallBackMessages.BOT_NOT_AVAILABLE }),
			);
		}

		let contactResult: Awaited<ReturnType<typeof this.contactService.exists>>;
		try {
			contactResult = await this.contactService.exists({
				platform: ConnectionPlatform.WEB,
				platformUserId: sessionId,
				businessId: foundBot.businessId,
			});
		} catch (e: unknown) {
			this.log.error(`Failed to onboard contact for session [${sessionId}]`, {
				error: e instanceof Error ? e.message : String(e),
			});
			return await this.publisherService.publish(
				replyChannel,
				"ERROR",
				JSON.stringify({ error: BotFallBackMessages.BOT_NOT_AVAILABLE }),
			);
		}

		const { contact, bridge, isNew } = contactResult!;
		const contactId = contact.id;
		const contactBusinessId = bridge.id;
		const businessId = foundBot.businessId;

		// ── Preflight ────────────────────────────────────────────────────
		const preflight = await this.planHandler.preflight(businessId, {
			feature: "web",
			action: isNew ? undefined : PricingTierActionName.BOT_RESPONSE,
			contactBusinessId,
			checkLimits: { messages: !isNew },
		});

		if (!preflight.allowed) {
			this.log.warn(`Preflight blocked business ${businessId}: ${preflight.blockCode}`);
			// Save user message so conversation context is preserved
			await this.conversationService.createMessage({
				contactBusinessId,
				role: MessageRole.USER,
				content: text,
				senderType: MessageSenderTypes.CONTACT,
				senderId: contactId,
			});
			return await this.publisherService.publish(
				replyChannel,
				"ERROR",
				JSON.stringify({ error: "This business is temporarily unavailable. Please try again later." }),
			);
		}

		if (isNew) {
			await this.conversationService.createMessage({
				contactBusinessId,
				role: MessageRole.ASSISTANT,
				content: foundBot.welcomeMessage ?? "",
				senderType: MessageSenderTypes.BOT,
				senderId: foundBot.id,
			});

			await this.publisherService.publish(
				replyChannel,
				BotWsEventTypes.SEND,
				JSON.stringify({ text: foundBot.welcomeMessage, messageId: null }),
			);
		}

		let agent: Awaited<ReturnType<typeof getAgentById>>;
		try {
			agent = await getAgentById(foundBot.agentId);
		} catch (e: unknown) {
			this.log.error(`Agent not found for agentId [${foundBot.agentId}]`, {
				error: e instanceof Error ? e.message : String(e),
			});
			return await this.publisherService.publish(
				replyChannel,
				"ERROR",
				JSON.stringify({ error: BotFallBackMessages.BOT_NOT_AVAILABLE }),
			);
		}

		if (agent.status !== Status.ACTIVE) {
			this.log.error(`Agent [${agent.id}] is not active`);
			return await this.publisherService.publish(
				replyChannel,
				"ERROR",
				JSON.stringify({ error: BotFallBackMessages.BOT_NOT_AVAILABLE }),
			);
		}

		const {
			name: agentName,
			description: agentDescription,
			tags: agentTags,
		} = agent;

		let currentVersion: AgentVersion | undefined;
		if (agent.currentAgentVersionId) {
			currentVersion = await this.agentVersionRepository.findById(
				agent.currentAgentVersionId,
			);
		}

		if (!currentVersion?.systemPrompt) {
			this.log.error(`Agent version not resolved for agent [${agent.id}]`);
			return await this.publisherService.publish(
				replyChannel,
				"ERROR",
				JSON.stringify({ error: BotFallBackMessages.BOT_NOT_AVAILABLE }),
			);
		}

		const { systemPrompt, llmModel, parameters, enableRAG } = currentVersion;

		const knowledgeBases = enableRAG
			? await this.knowledgeBaseRepository.findMany(
					eq(knowledgeBase.businessId, agent.businessId),
				)
			: [];

		const messages = await getLatestMessages(contactBusinessId, { limit: 3 });

		let aiText: string;
		try {
			const result = await generateText({
				model: this.aiService.getProvider("bedrock")(llmModel),
				system: this.buildAgentPrompt({
					systemPrompt,
					agentName,
					agentDescription: agentDescription ?? undefined,
					agentTags: agentTags ?? undefined,
					knowledgeBase: knowledgeBases
						.map((kb: any) => kb.metadata?.data ?? "")
						.join("\n\n"),
				}),
				maxOutputTokens: (parameters as any)?.maxResponseLength,
				maxSteps: 5,
				messages: [...messages, { role: MessageRole.USER, content: text }],
				temperature: (parameters as any)?.creativity,
				tools: this.toolService.fetchTools({ businessId, contactBusinessId }),
			});
			aiText = result.text;
		} catch (e: unknown) {
			this.log.error(`LLM generation failed for bot [${botId}]`, {
				error: e instanceof Error ? e.message : String(e),
			});
			return await this.publisherService.publish(
				replyChannel,
				"ERROR",
				JSON.stringify({ error: BotFallBackMessages.BOT_NOT_AVAILABLE }),
			);
		}

		this.log.info(`AI Response for session [${sessionId}]:`, aiText);

		// ── Deduct after successful AI generation ────────────────────────
		if (!isNew) {
			const deductResult = await this.planHandler.deduct(businessId, {
				action: PricingTierActionName.BOT_RESPONSE,
				description: `Bot response to contact ${contactBusinessId} via Web`,
			});

			if (!deductResult.success) {
				this.log.warn(`Credit deduction failed for business ${businessId}`);
			}
		}

		const [, assistantMessage] = await Promise.all([
			this.conversationService.createMessage({
				contactBusinessId,
				role: MessageRole.USER,
				content: text,
				senderType: MessageSenderTypes.CONTACT,
				senderId: contactId,
			}),
			this.conversationService.createMessage({
				contactBusinessId,
				role: MessageRole.ASSISTANT,
				content: aiText,
				senderType: MessageSenderTypes.BOT,
				senderId: foundBot.id,
			}),
		]);

		await this.publisherService.publish(
			replyChannel,
			BotWsEventTypes.SEND,
			JSON.stringify({
				text: aiText,
				messageId: assistantMessage?.id ?? null,
			}),
		);
	}

	private async handleUpdate(params: {
		messageId: number;
		text: string;
		replyChannel: string;
	}) {
		const { messageId, text, replyChannel } = params;

		const updated = await this.conversationService.updateMessage(
			messageId,
			text,
		);
		if (!updated) {
			this.log.error(`Message not found for update: ${messageId}`);
			return await this.publisherService.publish(
				replyChannel,
				"ERROR",
				JSON.stringify({ error: "Message not found" }),
			);
		}

		await this.publisherService.publish(
			replyChannel,
			BotWsEventTypes.UPDATE,
			JSON.stringify({ messageId, text: updated.content }),
		);
	}

	private async handleDelete(params: {
		messageId: number;
		replyChannel: string;
	}) {
		const { messageId, replyChannel } = params;

		await this.conversationService.deleteMessage(messageId);

		await this.publisherService.publish(
			replyChannel,
			BotWsEventTypes.DELETE,
			JSON.stringify({ messageId }),
		);
	}
}
