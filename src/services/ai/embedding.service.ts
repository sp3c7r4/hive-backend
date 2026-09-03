/**
 * @info - Local CPU embeddings via @mastra/fastembed (fast-bge-small-en-v1.5,
 * 384-dim). Lazy-init ONNX session; model downloads on first use.
 */
import { EmbeddingModel, FlagEmbedding } from "@mastra/fastembed";
import { logger } from "@/utils";

export class EmbeddingService {
	private static instance: EmbeddingService;

	private model: FlagEmbedding | null = null;
	private readonly log = logger;

	static getInstance(): EmbeddingService {
		if (!this.instance) this.instance = new EmbeddingService();
		return this.instance;
	}

	private async init(): Promise<FlagEmbedding> {
		if (!this.model) {
			this.log.info("[Embedding] Loading fast-bge-small-en-v1.5 (first run downloads the model)...");
			this.model = await FlagEmbedding.init({
				model: EmbeddingModel.BGESmallENV15,
			});
		}
		return this.model;
	}

	/** @info - Query-side embedding (query instruction applied by the model) */
	embedQuery = async (text: string): Promise<number[]> => {
		const model = await this.init();
		return model.queryEmbed(text.slice(0, 1000));
	};

	/** @info - Passage-side embedding for ingestion */
	embedMany = async (texts: string[]): Promise<number[][]> => {
		const model = await this.init();
		const out: number[][] = [];
		for await (const batch of model.embed(texts, 8)) out.push(...batch);
		return out;
	};

	/** @info - PostgreSQL vector literal: "[0.1,0.2,...]" */
	static toVectorLiteral(vec: number[]): string {
		return `[${vec.join(",")}]`;
	}
}
