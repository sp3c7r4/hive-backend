import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, Next } from "hono";
import { isPrivateIP } from "@/helpers";

/* @info - Captures request metadata (IP, user agent, location) for the
 * session registry. IP extraction is header-only (no lookup); location
 * resolution is deferred to the registry's background enrichment so an
 * external geo API round-trip can never stall a response (the old
 * await-ipapi-in-middleware design added up to 5s latency per request). */
export const metadataGrabber = async (c: Context, next: Next) => {
	let ipAddress: string | null = null;

	const xff = c.req.header("x-forwarded-for");
	if (xff) ipAddress = xff.split(",")[0]?.trim() || null;
	if (!ipAddress) ipAddress = c.req.header("x-real-ip") || null;
	if (!ipAddress) {
		try {
			ipAddress = getConnInfo(c).remote.address || null;
		} catch {
			/* no socket info (e.g. some adapters) - leave empty */
		}
	}
	if (ipAddress === "::1") ipAddress = "127.0.0.1";

	/* @info - Private/loopback networks resolve instantly, no API call */
	const location = ipAddress && isPrivateIP(ipAddress) ? "Local Network" : "";

	c.set("clientMetadata", {
		ipAddress: ipAddress ?? "",
		location,
		userAgent: c.req.header("user-agent") || "",
	});
	await next();
};
