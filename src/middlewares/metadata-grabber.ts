import type { Context, Next } from "hono";
import { getLocationFromIP } from "@/helpers";

export const metadataGrabber = async (c: Context, next: Next) => {
	const ipAddress = c.req.header("x-forwarded-for") || "Unknown IP";
	console.log(ipAddress);
	const location =
		ipAddress === "Unknown IP"
			? "Unknown Location"
			: await getLocationFromIP(ipAddress);

	const clientMetadata = {
		ipAddress: ipAddress,
		location: location,
		userAgent: c.req.header("user-agent") || "Unknown User Agent",
	};

	c.set("clientMetadata", clientMetadata);
	await next();
};
