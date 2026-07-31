import type { Context, Next } from "hono";
import { getAgentById } from "@/helpers";

export function validateAgent(agentId: string | number) {
	return async (c: Context, n: Next) => {
		const id = Number(agentId);
		if (!Number.isInteger(id) || id <= 0) {
			return c.json({ error: "Invalid agent ID" }, 400);
		}

		await getAgentById(id);

		return n();
	};
}
