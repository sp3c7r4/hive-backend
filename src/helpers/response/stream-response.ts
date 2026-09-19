/**
 * @info - Hand a token stream back to the client without letting a reverse
 * proxy buffer it.
 *
 * nginx buffers proxied responses by default, which collapses a token stream
 * into a single burst delivered once the model finishes — the stream then looks
 * exactly like a plain request/response. `X-Accel-Buffering: no` is nginx's
 * documented per-response opt-out, so a streaming endpoint needs no matching
 * `proxy_buffering off` carve-out in the nginx config, and one cannot be
 * forgotten when a new streaming endpoint is added.
 *
 * `no-cache, no-transform` stops intermediaries caching or re-compressing the
 * body, either of which would reintroduce the same buffering.
 *
 * Lives here rather than beside the JSON envelope helpers: that module declares
 * its own `Response<T>` envelope interface, which shadows the global `Response`
 * type. JSON responses deliberately do NOT use this — they are small, and
 * buffering them is both fine and desirable.
 */
export const streamResponse = (response: Response): Response => {
	const headers = new Headers(response.headers);
	headers.set("X-Accel-Buffering", "no");
	headers.set("Cache-Control", "no-cache, no-transform");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
};
