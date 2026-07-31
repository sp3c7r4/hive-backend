import { ToolLoopAgent, hasToolCall, stepCountIs } from "ai";
import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { BaseWorkerService, RelationalRepository } from "@/bases";
import {
	AgentTools,
	BotFallBackMessages,
	ConnectionPlatform,
	MessageRole,
	MessageSenderTypes,
	Status,
	WhatsappQueueNames,
	PricingTierActionName,
} from "@/enums";
import {
	getAgentById,
	getAgentModel,
	getLatestMessages,
	PlanHandler,
	PreflightBlockCode,
} from "@/helpers";
import {
	type AgentVersion,
	agentVersion,
	knowledgeBase,
} from "@/modules/agent/models";
import { AgentService } from "@/modules/agent/agent.service";
import { ContactRepository } from "@/modules/contact";
import { BotRepository } from "@/modules/bot/bot.repository";
import { bot } from "@/modules/bot/bot.model";
import { ConversationService } from "@/modules/conversation/conversation.service";
import { serviceLogger } from "@/utils";
import { AiService, AiToolService } from "../ai.service";
import { BaileysEngine } from "../engine/baileys.engine.service";

/**
 * Tools whose own return value IS the final customer-facing message (they
 * return `{ type: "text", content }` — see AgentService.registerTools).
 * Once one of these is called, we stop the loop immediately instead of
 * paying for another model round-trip whose output we'd just discard in
 * favor of the tool's own text. Add a tool's name here once you've updated
 * it to return that `{ type: "text", content }` shape.
 *
 * IMPORTANT: only add a tool here if it is ALWAYS a terminal action —
 * i.e. there's never a reason the model would need to call another tool
 * right after it in the same turn. ONBOARD is deliberately NOT here: it
 * can be an intermediate step (e.g. place_order asks for a missing email,
 * the model calls onboard, then needs to immediately retry place_order in
 * the same turn). Short-circuiting right after onboard would silently
 * drop that retry. CLEAR_CART is excluded for the same reason — "clear my
 * cart and add the chinos instead" is a real message shape.
 */
const DIRECT_RESPONSE_TOOLS = [
	AgentTools.GET_PRODUCTS,
	AgentTools.FIND_PRODUCT,
	AgentTools.CHECK_ORDER_STATUS,
];

/** The fallback message sent when PlanHandler.preflight() blocks */
const PLAN_BLOCK_FALLBACK =
	"This business is temporarily unavailable. Please try again later.";

export class WhatsappMessageWorkerService extends BaseWorkerService {
	private static instance: WhatsappMessageWorkerService;

	/** @info - Services */
	private readonly aiService: AiService;
	private readonly toolService: AiToolService;
	private readonly conversationService: ConversationService;
	private readonly agentService: AgentService;
	private readonly contactRepository = ContactRepository.getInstance();

	private readonly botRepository = BotRepository.getInstance();
	private readonly knowledgeBaseRepository = new RelationalRepository(
		knowledgeBase,
	);
	private readonly agentVersionRepository = new RelationalRepository(
		agentVersion,
	);

	/** @info - Utilities */
	private readonly log = serviceLogger("Whatsapp Message Worker Service");
	private readonly planHandler = PlanHandler.getInstance();

	static getInstance() {
		if (!this.instance) {
			this.instance = new WhatsappMessageWorkerService();
		}
		return this.instance;
	}

	private constructor() {
		super({
			queueName: WhatsappQueueNames.MESSAGES,
			alias: "WhatsappMessageWorker",
			concurrency: 10,
		});
		this.aiService = AiService.getInstance();
		this.toolService = AiToolService.getInstance();
		this.conversationService = ConversationService.getInstance();
		this.agentService = AgentService.getInstance();
	}

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
			raw,
		} = job.data;

		// ── Preflight: subscription + feature + credit + limit checks ──────
		const preflight = await this.planHandler.preflight(businessId, {
			feature: "whatsapp",
			action: isNew ? undefined : PricingTierActionName.BOT_RESPONSE,
			contactBusinessId,
			checkLimits: { messages: !isNew },
		});

		if (!preflight.allowed) {
			this.log.warn(
				`Preflight blocked business ${businessId}: ${preflight.blockCode}`,
			);
			// Save user message so conversation context is preserved
			await this.conversationService.createMessage({
				platformMessageId: messageId,
				contactBusinessId,
				role: MessageRole.USER,
				content: text,
				senderType: MessageSenderTypes.CONTACT,
				senderId: contactId,
			});
			return await BaileysEngine.sendMessage(
				connectionId,
				from,
				{ text: PLAN_BLOCK_FALLBACK },
				raw,
			);
		}

		// ── Bot + Agent validation ─────────────────────────────────────────
		const foundBot = await this.botRepository.findOne(
			eq(bot.channelId, connectionId),
		);

		if (!foundBot) {
			this.log.warn(`No bot deployed to channel: ${connectionId}`);
			return await BaileysEngine.sendMessage(
				connectionId,
				from,
				{ text: BotFallBackMessages.CHANNEL_UNMONITORED },
				raw,
			);
		}

		if (foundBot.status === Status.PAUSED || !foundBot.isActive) {
			this.log.error(`Bot with id [${foundBot.id}] isn't currently active`);
			return await BaileysEngine.sendMessage(
				connectionId,
				from,
				{ text: BotFallBackMessages.BOT_NOT_AVAILABLE },
				raw,
			);
		}

		let agent: Awaited<ReturnType<typeof getAgentById>>;
		try {
			agent = await getAgentById(foundBot.agentId);
		} catch (e: unknown) {
			this.log.error(`Agent not found for agentId [${foundBot.agentId}]`, {
				error: e instanceof Error ? e.message : String(e),
			});
			return await BaileysEngine.sendMessage(
				connectionId,
				from,
				{ text: BotFallBackMessages.BOT_NOT_AVAILABLE },
				raw,
			);
		}

		if (agent.status !== Status.ACTIVE) {
			this.log.error(
				`Agent [${agent.id}] is not active (status: ${agent.status})`,
			);
			return await BaileysEngine.sendMessage(
				connectionId,
				from,
				{ text: BotFallBackMessages.BOT_NOT_AVAILABLE },
				raw,
			);
		}

		let responseText = "";

		// ── AI Generation ──────────────────────────────────────────────────
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
				return await BaileysEngine.sendMessage(
					connectionId,
					from,
					{ text: BotFallBackMessages.BOT_NOT_AVAILABLE },
					raw,
				);
			}

			const { systemPrompt, llmModel, parameters, enableRAG } = currentVersion;

			const knowledgeBases = enableRAG
				? await this.knowledgeBaseRepository.findMany(
						eq(knowledgeBase.businessId, agent.businessId),
					)
				: [];

			const messages = await getLatestMessages(contactBusinessId, { limit: 3 });

			// Fetched fresh per turn rather than trusting conversation history
			// to reflect it — the contact could have onboarded several turns
			// ago, outside the small message window getLatestMessages pulls.
			const contactRecord = await this.contactRepository.findById(contactId);

			try {
				const bloomAgent = new ToolLoopAgent({
					model: this.aiService.getProvider("openai")(getAgentModel(llmModel)),
					instructions: this.agentService.buildAgentPrompt({
						systemPrompt,
						agentName,
						agentDescription: agentDescription ?? undefined,
						agentTags: agentTags ?? undefined,
						knowledgeBase: knowledgeBases
							.map((kb: any) => kb.metadata?.data ?? "")
							.join("\n\n"),
						customerEmail: contactRecord?.email,
					}),
					// maxOutputTokens intentionally removed — it was hard-truncating
					// responses mid-generation. Use the soft prompt-level guidance
					// in buildAgentPrompt above if you want a length preference.
					temperature: (parameters as any)?.creativity,
					tools: this.toolService.fetchTools({
						/** @todo -  Must add cartId for the getCartTool */
						businessId,
						contactBusinessId,
						platform: ConnectionPlatform.WHATSAPP,
						platformUserId: from,
						connectionId,
					}),
					// stepCountIs(20) preserves the previous default cap for normal
					// multi-step tool use (cart, checkout, etc). hasToolCall only
					// accepts a single tool name, so we map each direct-response
					// tool to its own condition — stopWhen stops the loop the
					// instant ANY condition in the array is met, so this still
					// short-circuits as soon as one of them is called.
					stopWhen: [
						stepCountIs(20),
						...DIRECT_RESPONSE_TOOLS.map((toolName) => hasToolCall(toolName)),
					],
				});

				const gen = await bloomAgent.generate({
					messages: [...messages, { role: MessageRole.USER, content: text }],
				});

				// Prefer the model's own synthesis: gen.text already accounts for
				// EVERY tool call made this turn, including turns that mix a
				// type:text tool (e.g. onboard) with a non-type:text tool (e.g. a
				// successful place_order) — scanning tool results and grabbing the
				// first type:text match would wrongly return onboard's "email
				// saved!" and discard the model's actual final summary.
				//
				// gen.text is only empty when stopWhen (see DIRECT_RESPONSE_TOOLS
				// above) cut the loop short before the model got a turn to write
				// closing text — in that case, fall back to the raw tool result,
				// searching from the MOST RECENT step backward so we grab the
				// call that actually triggered the stop, not an earlier one.
				if (gen.text && gen.text.trim()) {
					responseText = gen.text;
				} else {
					const toolResults = (gen.steps ?? [])
						.flatMap((step: any) => step.toolResults ?? [])
						.reverse();

					for (const tr of toolResults) {
						try {
							const rawOutput = tr.output ?? tr.result;
							if (!rawOutput) continue;

							const parsed = JSON.parse(rawOutput);
							if (parsed.type === "text" && parsed.content) {
								responseText = parsed.content;
								break;
							}
						} catch {
							// Not every tool result is JSON (e.g. GET_PRODUCT_DETAILS
							// returns a raw DB row) — keep looking.
						}
					}
				}
			} catch (e: unknown) {
				this.log.error(`LLM generation failed for [${connectionId}]`, {
					error: e instanceof Error ? e.message : String(e),
				});
				return await BaileysEngine.sendMessage(
					connectionId,
					from,
					{ text: BotFallBackMessages.BOT_NOT_AVAILABLE },
					raw,
				);
			}

			// ── Deduct credits after successful AI generation ───────────────
			const result = await this.planHandler.deduct(businessId, {
				action: PricingTierActionName.BOT_RESPONSE,
				description: `Bot response to contact ${contactBusinessId} via WhatsApp`,
				referenceId: messageId ? Number(messageId) : undefined,
			});

			if (!result.success) {
				this.log.warn(
					`Credit deduction failed for business ${businessId} — message will still be delivered`,
				);
			}

			this.log.info(
				`AI Response for ${pushName ?? from} [msg:${messageId}]:`,
				responseText,
			);
		} else {
			responseText = foundBot.welcomeMessage ?? "";
		}

		// ── Save messages + Send ───────────────────────────────────────────
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
				content: responseText,
				senderType: MessageSenderTypes.BOT,
				senderId: foundBot.id,
			}),
		]);

		await BaileysEngine.sendMessage(
			connectionId,
			from,
			{ text: responseText },
			raw,
		);
	}
}
