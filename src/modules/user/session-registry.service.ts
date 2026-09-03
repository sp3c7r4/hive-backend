/**
 * @info - Live session registry on top of the existing Redis refresh tokens.
 *
 * refresh:{userId}-{ts} keys ARE the sessions (value = authId, TTL 7d).
 * This service adds optional metadata per session (session:{refreshId}),
 * lists sessions, and revokes one by deleting the same keys logout uses.
 */
import { TTL } from "@/constants";
import { CacheService } from "@/services/cache.service";

export interface SessionMeta {
	userAgent?: string;
	ipAddress?: string;
	location?: string;
	createdAt: number;
	lastActiveAt: number;
}

export interface SessionRow {
	id: string;
	device: string | null;
	ipAddress: string | null;
	location: string | null;
	createdAt: number;
	lastActiveAt: number;
	current: boolean;
}

/** @info - Demo metadata for sessions minted before the registry existed
 * (SESSION_DEMO_METADATA=on). Synthetic rows are computed on read, never
 * written, so prod stays honest. */
const DEMO_SESSIONS: Array<{ ua: string; ip: string; location: string }> = [
	{
		ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
		ip: "105.112.40.18",
		location: "Lagos, Nigeria",
	},
	{
		ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
		ip: "102.89.44.7",
		location: "Abuja, Nigeria",
	},
	{
		ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
		ip: "197.210.65.3",
		location: "Port Harcourt, Nigeria",
	},
	{
		ua: "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
		ip: "41.190.2.140",
		location: "Accra, Ghana",
	},
];

const DEMO = process.env.SESSION_DEMO_METADATA === "on";

/** @info - Tiny UA parser: "Chrome on Windows", "Safari on iPhone" */
export function deviceLabel(ua?: string): string | null {
	if (!ua) return null;
	const device = /iPhone/.test(ua)
		? "iPhone"
		: /iPad/.test(ua)
			? "iPad"
			: /Android/.test(ua)
				? "Android"
				: /Windows/.test(ua)
					? "Windows"
					: /Mac OS X|Macintosh/.test(ua)
						? "Mac"
						: null;
	const browser = /Edg\//.test(ua)
		? "Edge"
		: /Chrome\//.test(ua)
			? "Chrome"
			: /Firefox\//.test(ua)
				? "Firefox"
				: /Safari\//.test(ua)
					? "Safari"
					: null;
	const parts = [browser, device].filter(Boolean);
	return parts.length ? parts.join(" on ") : "Unknown device";
}

export class SessionRegistryService {
	private static instance: SessionRegistryService;
	private readonly cache = CacheService.getInstance();

	static getInstance(): SessionRegistryService {
		if (!this.instance) this.instance = new SessionRegistryService();
		return this.instance;
	}

	/** @info - Metadata only; the refresh token itself is the session. */
	register = async (
		refreshId: string,
		meta: { userAgent?: string; ipAddress?: string; location?: string },
	) => {
		try {
			const now = Date.now();
			await this.cache.redis.set(
				`session:${refreshId}`,
				JSON.stringify({
					userAgent: meta.userAgent ?? "",
					ipAddress: meta.ipAddress ?? "",
					location: meta.location ?? "",
					createdAt: now,
					lastActiveAt: now,
				} satisfies SessionMeta),
				"EX",
				TTL.IN_7_DAYS,
			);
		} catch {
			/* @info - Registry is best-effort; never fail auth for it */
		}
	};

	/** @info - Refresh rotation: carry the old record forward, no GeoIP re-lookup */
	copyOnRotate = async (oldRefreshId: string, newRefreshId: string) => {
		try {
			const raw = await this.cache.redis.get(`session:${oldRefreshId}`);
			if (!raw) return;
			const meta = JSON.parse(raw) as SessionMeta;
			await this.cache.redis.del(`session:${oldRefreshId}`);
			await this.cache.redis.set(
				`session:${newRefreshId}`,
				JSON.stringify({ ...meta, lastActiveAt: Date.now() }),
				"EX",
				TTL.IN_7_DAYS,
			);
		} catch {
			/* best-effort */
		}
	};

	/** @info - Live sessions for a user, newest first */
	listForUser = async (
		userId: number,
		currentAuthId?: string,
	): Promise<SessionRow[]> => {
		const keys: string[] = [];
		let cursor = "0";
		do {
			const [next, batch] = await this.cache.redis.scan(
				cursor,
				"MATCH",
				`refresh:${userId}-*`,
				"COUNT",
				200,
			);
			cursor = next;
			keys.push(...batch);
		} while (cursor !== "0");

		const rows: SessionRow[] = [];
		for (const key of keys) {
			const tsRaw = key.split("-").pop();
			const createdAt = Number(tsRaw) || Date.now();
			const rawAuth = await this.cache.redis.get(key).catch(() => null);
			const authId = rawAuth
				? (JSON.parse(rawAuth) as string)
				: null;
			const raw = await this.cache.redis
				.get(`session:${key}`)
				.catch(() => null);

			let meta: SessionMeta | null = null;
			if (raw) {
				meta = JSON.parse(raw) as SessionMeta;
			} else if (DEMO) {
				/* @info - Synthetic preview for pre-registry sessions (read-only) */
				const demo =
					DEMO_SESSIONS[
						[...key].reduce((a, ch) => a + ch.charCodeAt(0), 0) %
							DEMO_SESSIONS.length
					];
				meta = {
					userAgent: demo.ua,
					ipAddress: demo.ip,
					location: demo.location,
					createdAt,
					lastActiveAt: createdAt,
				};
			}

			rows.push({
				id: key,
				device: deviceLabel(meta?.userAgent),
				ipAddress: meta?.ipAddress || null,
				location: meta?.location || null,
				createdAt: meta?.createdAt ?? createdAt,
				lastActiveAt: meta?.lastActiveAt ?? createdAt,
				current: !!authId && authId === currentAuthId,
			});
		}
		return rows.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
	};

	/** @info - Revoke one session: refresh + auth cache + metadata */
	revoke = async (userId: number, refreshId: string): Promise<boolean> => {
		if (!refreshId.startsWith(`refresh:${userId}-`)) return false;
		const rawAuth = await this.cache.redis.get(refreshId).catch(() => null);
		const authId = rawAuth
			? (JSON.parse(rawAuth) as string)
			: null;
		await this.cache.redis.del(refreshId);
		if (authId) await this.cache.redis.del(authId);
		await this.cache.redis.del(`session:${refreshId}`);
		return true;
	};
}
