import { generateText } from "ai";
import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { BaseWorkerService, RelationalRepository } from "@/bases";
import {
	BotFallBackMessages,
	MessageRole,
	MessageSenderTypes,
	PricingTierActionName,
	Status,
	TelegramQueueNames,
} from "@/enums";
import { getAgentById, getLatestMessages, PlanHandler } from "@/helpers";
import type { AgentStyle } from "@/interfaces";
import {
	type AgentVersion,
	agentVersion,
	knowledgeBase,
} from "@/modules/agent/models";
import { BotRepository } from "@/modules/bot/bot.repository";
import { bot } from "@/modules/bot/bot.model";
import { ConversationService } from "@/modules/conversation/conversation.service";
import { serviceLogger } from "@/utils";
import { AiService } from "../ai.service";
import { TelegramEngine } from "../engine/telegram.engine.service";

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

export class TelegramMessageWorkerService extends BaseWorkerService {
	private static instance: TelegramMessageWorkerService;

	/** @info - Services */
	private readonly aiService: AiService;
	private readonly conversationService: ConversationService;

	private readonly botRepository = BotRepository.getInstance();
	private readonly knowledgeBaseRepository = new RelationalRepository(
		knowledgeBase,
	);
	private readonly agentVersionRepository = new RelationalRepository(
		agentVersion,
	);

	/** @info - Utils */
	private readonly log = serviceLogger("Telegram Message Worker Service");
	private readonly planHandler = PlanHandler.getInstance();

	static getInstance() {
		if (!this.instance) {
			this.instance = new TelegramMessageWorkerService();
		}
		return this.instance;
	}

	private constructor() {
		super({
			queueName: TelegramQueueNames.MESSAGES,
			alias: "TelegramMessageWorker",
			concurrency: 10,
		});
		this.aiService = AiService.getInstance();
		this.conversationService = ConversationService.getInstance();
	}

	private buildAgentPrompt = (params: AiInfoParams) => {
		const name = params.agentName || "Nova";
		const description = params.agentDescription || "A helpful AI assistant.";
		const tags = params.agentTags?.length ? params.agentTags.join(", ") : "";
		const style = STYLE_MAP[params.style ?? ""] ?? "clear and helpful";
		const knowledgeBase = params.knowledgeBase || "";
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
			"- Never use em dashes (—) in your responses.",
		);

		if (maxResponseLength)
			parts.push(
				`- Limit your response to a maximum of ${maxResponseLength} tokens.`,
			);

		if (knowledgeBase) {
			parts.push(
				"",
				"## Knowledge Base",
				"",
				"Use the following reference material to inform your answers. Treat it as your primary source of truth and prefer it over general knowledge when relevant.",
				"",
				"<knowledge_base>",
				knowledgeBase,
				"</knowledge_base>",
			);
		}

		return parts.join("\n");
	};

	protected async process(job: Job) {
		const {
			connectionId,
			contactId,
			businessId,
			isNew,
			contactBusinessId,
			from,
			text = "Hello",
			pushName,
			messageId,
		} = job.data;

		// ── Preflight ────────────────────────────────────────────────────
		const preflight = await this.planHandler.preflight(businessId, {
			feature: "telegram",
			action: isNew ? undefined : PricingTierActionName.BOT_RESPONSE,
			contactBusinessId,
			checkLimits: { messages: !isNew },
		});

		if (!preflight.allowed) {
			this.log.warn(`Preflight blocked business ${businessId}: ${preflight.blockCode}`);
			// Save user message so conversation context is preserved
			await this.conversationService.createMessage({
				platformMessageId: messageId,
				contactBusinessId,
				role: MessageRole.USER,
				content: text,
				senderType: MessageSenderTypes.CONTACT,
				senderId: contactId,
			});
			return await TelegramEngine.getInstance().sendMessage(
				connectionId,
				from,
				{ text: "This business is temporarily unavailable. Please try again later." },
				Number(messageId),
			);
		}

		const foundBot = await this.botRepository.findOne(
			eq(bot.channelId, connectionId),
		);

		if (!foundBot) {
			this.log.warn(`No bot deployed to channel: ${connectionId}`);
			return await TelegramEngine.getInstance().sendMessage(
				connectionId,
				from,
				{ text: BotFallBackMessages.CHANNEL_UNMONITORED },
				Number(messageId),
			);
		}

		if (foundBot.status === Status.PAUSED || !foundBot.isActive) {
			this.log.error(`Bot with id [${foundBot.id}] isn't currently active`);
			return await TelegramEngine.getInstance().sendMessage(
				connectionId,
				from,
				{ text: BotFallBackMessages.BOT_NOT_AVAILABLE },
				Number(messageId),
			);
		}

		let agent: Awaited<ReturnType<typeof getAgentById>>;
		try {
			agent = await getAgentById(foundBot.agentId);
		} catch (e: unknown) {
			this.log.error(`Agent not found for agentId [${foundBot.agentId}]`, {
				error: e instanceof Error ? e.message : String(e),
			});
			return await TelegramEngine.getInstance().sendMessage(
				connectionId,
				from,
				{ text: BotFallBackMessages.BOT_NOT_AVAILABLE },
				Number(messageId),
			);
		}

		if (agent.status !== Status.ACTIVE) {
			this.log.error(
				`Agent [${agent.id}] is not active (status: ${agent.status})`,
			);
			return await TelegramEngine.getInstance().sendMessage(
				connectionId,
				from,
				{ text: BotFallBackMessages.BOT_NOT_AVAILABLE },
				Number(messageId),
			);
		}

		let response: Awaited<ReturnType<typeof generateText>> | { text: string };
		if (!isNew) {
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
				return await TelegramEngine.getInstance().sendMessage(
					connectionId,
					from,
					{ text: BotFallBackMessages.BOT_NOT_AVAILABLE },
					Number(messageId),
				);
			}

			const { systemPrompt, llmModel, parameters, enableRAG } = currentVersion;

			const knowledgeBases = enableRAG
				? await this.knowledgeBaseRepository.findMany(
						eq(knowledgeBase.businessId, agent.businessId),
					)
				: [];

			const messages = await getLatestMessages(contactBusinessId, { limit: 3 });

			try {
				response = await generateText({
					messages: [...messages, { role: MessageRole.USER, content: text }],
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
					temperature: (parameters as any)?.creativity,
				});
			} catch (e: unknown) {
				this.log.error(`LLM generation failed for [${connectionId}]`, {
					error: e instanceof Error ? e.message : String(e),
				});
				return await TelegramEngine.getInstance().sendMessage(
					connectionId,
					from,
					{ text: BotFallBackMessages.BOT_NOT_AVAILABLE },
					Number(messageId),
				);
			}

			await Promise.all([
				this.conversationService.createMessage({
					platformMessageId: messageId,
					contactBusinessId,
					role: MessageRole.USER,
					content: text,
					senderType: MessageSenderTypes.CONTACT,
					senderId: contactId,
				}),
				this.conversationService.createMessage({
					contactBusinessId,
					role: MessageRole.ASSISTANT,
					content: response.text,
					senderType: MessageSenderTypes.BOT,
					senderId: foundBot.id,
				}),
			]);

			this.log.info(
				`AI Response for ${pushName ?? from} [msg:${messageId}]:`,
				response.text,
			);
		} else {
			response = { text: foundBot.welcomeMessage ?? "" };
		}

		// ── Deduct after successful AI generation ────────────────────────
		if (!isNew) {
			const result = await this.planHandler.deduct(businessId, {
				action: PricingTierActionName.BOT_RESPONSE,
				description: `Bot response to contact ${contactBusinessId} via Telegram`,
				referenceId: messageId ? Number(messageId) : undefined,
			});

			if (!result.success) {
				this.log.warn(`Credit deduction failed for business ${businessId}`);
			}
		}

		await TelegramEngine.getInstance().sendMessage(
			connectionId,
			from,
			{ text: response.text },
			Number(messageId),
		);
	}
}
