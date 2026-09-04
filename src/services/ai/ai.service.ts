/**
 * @info - Minimal single point of entry for AI model access (v1: DeepSeek
 * only). The tutor, course builder and grading all share this so a model
 * or provider change is one config line, not three call sites. Lazy
 * construction: a missing key only breaks calls to the provider that
 * needs it. Multi-provider surface (openai/bedrock/fallback) gets added
 * only when a feature that needs it ships.
 */
import { createDeepSeek } from "@ai-sdk/deepseek";
import { config } from "@/config";

export class AiService {
	private static instance: AiService;
	private _deepseek?: ReturnType<typeof createDeepSeek>;

	static getInstance(): AiService {
		if (!this.instance) this.instance = new AiService();
		return this.instance;
	}

	private get deepseek() {
		if (!this._deepseek) {
			this._deepseek = createDeepSeek({ apiKey: config.ai.deepseekApiKey });
		}
		return this._deepseek;
	}

	/** @info - Defaults to config.ai.deepseekModel (currently
	 * deepseek-v4-flash); any later upgrade or -exp swap lands in one
	 * config line and every AI feature inherits it. */
	model() {
		return this.deepseek(config.ai.deepseekModel);
	}
}
