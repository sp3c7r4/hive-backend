/**
 * @info - Vendors the embedding model into dist/models at build time.
 *
 * The app box gets HTTP 403 from Hugging Face when it tries this download at runtime, so the
 * model has to arrive with the artifact. The build runs on a machine that can reach Hugging
 * Face, which is the whole point of doing it here.
 *
 * This never fails the build: a deploy that ships without the model still serves every other
 * feature, and the tutor degrades to answering from general knowledge rather than erroring.
 */
import { mkdir } from "node:fs/promises";
import { EmbeddingModel, FlagEmbedding } from "@mastra/fastembed";

const CACHE_DIR = "./dist/models";

export const warmEmbeddingModel = async (): Promise<void> => {
	try {
		await mkdir(CACHE_DIR, { recursive: true });
		const model = await FlagEmbedding.init({
			model: EmbeddingModel.BGESmallENV15,
			cacheDir: CACHE_DIR,
		});
		await model.queryEmbed("warm the model so the files land in the artifact");
		console.log(`[build] embedding model vendored into ${CACHE_DIR}`);
	} catch (error) {
		console.warn(
			"[build] could not vendor the embedding model; the deploy will still work, and the tutor will answer without course materials:",
			error instanceof Error ? error.message : error,
		);
	}
};
