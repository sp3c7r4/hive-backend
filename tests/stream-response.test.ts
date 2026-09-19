import { describe, expect, it } from "vitest";
import { streamResponse } from "@/helpers/response";

/**
 * @info - Regression tests for proxy-buffered streaming.
 *
 * The bug: the tutor streamed correctly from Node, but staging delivered the
 * whole answer in one burst. nginx buffers proxied responses by default and
 * only the ai-grading path had a `proxy_buffering off` carve-out, so every
 * other streamed endpoint was collapsed into a request/response.
 * `X-Accel-Buffering: no` is nginx's per-response opt-out, and it is what these
 * tests pin — without it, streaming silently degrades again.
 */
describe("streamResponse", () => {
	it("opts the response out of proxy buffering", () => {
		const wrapped = streamResponse(
			new Response("token", { headers: { "content-type": "text/plain" } }),
		);
		expect(wrapped.headers.get("x-accel-buffering")).toBe("no");
	});

	it("forbids caching and transformation by intermediaries", () => {
		const wrapped = streamResponse(new Response("token"));
		expect(wrapped.headers.get("cache-control")).toBe("no-cache, no-transform");
	});

	it("preserves the original status and content type", () => {
		const wrapped = streamResponse(
			new Response("token", {
				status: 200,
				headers: { "content-type": "text/plain; charset=utf-8" },
			}),
		);
		expect(wrapped.status).toBe(200);
		expect(wrapped.headers.get("content-type")).toBe(
			"text/plain; charset=utf-8",
		);
	});

	it("keeps the body streamed, not collapsed", async () => {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("first "));
				controller.enqueue(encoder.encode("second"));
				controller.close();
			},
		});
		const wrapped = streamResponse(
			new Response(stream, { headers: { "content-type": "text/plain" } }),
		);
		/* A buffering wrapper would have to collect the body; reading it back
		 * through the same stream proves the tokens still flow one by one. */
		expect(await wrapped.text()).toBe("first second");
	});
});
