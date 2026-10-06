/**
 * @info - Local CPU embeddings via @mastra/fastembed (fast-bge-small-en-v1.5,
 * 384-dim). Lazy-init ONNX session.
 *
 * The model files are vendored into the build by scripts/warm-embedding-model.ts, because
 * the app box cannot fetch them: Hugging Face answers the download with HTTP 403 there, and
 * that took the whole tutor down with it. The copy in dist/models is used when it exists;
 * otherwise the library downloads as before, which is what development does.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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

	/** @info - The vendored model directory, when the build put one there. */
	private vendoredDir = (): string | null => {
		const dir = join(process.cwd(), "dist", "models");
		/* @info - The library downloads a tarball and extracts it to a directory named after
		 * the model, so that directory is what a successful vendoring leaves behind. Checking
		 * for the tarball instead would reject the very copy the build just made, and a
		 * half-finished download leaves the directory name too, hence the size check. */
		const extracted = join(dir, "fast-bge-small-en-v1.5");
		if (!existsSync(extracted)) return null;
		try {
			return readdirSync(extracted).length > 0 ? dir : null;
		} catch {
			return null;
		}
	};

	private async init(): Promise<FlagEmbedding> {
		if (!this.model) {
			const vendored = this.vendoredDir();
			this.log.info(
				vendored
					? `[Embedding] Loading fast-bge-small-en-v1.5 from ${vendored}`
					: "[Embedding] Loading fast-bge-small-en-v1.5 (no vendored copy; the model will be downloaded)",
			);
			this.model = await FlagEmbedding.init({
				model: EmbeddingModel.BGESmallENV15,
				...(vendored ? { cacheDir: vendored } : {}),
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
