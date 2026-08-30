import type Redis from "ioredis";
import { CacheService } from "@/services/cache.service";
import { serviceLogger } from "@/utils";
import { WebsocketEngine } from "./websocket.engine";

/**
 * @class ChatPubSubService
 * @description Redis pub/sub fanout for chat events. One subscriber per
 *              process (duplicate of the cache client) subscribed on demand
 *              to `chat:user:{userId}` channels; every server instance hears
 *              every event and forwards to its own sockets via WebsocketEngine.
 */
export class ChatPubSubService {
	private static instance: ChatPubSubService;

	static getInstance(): ChatPubSubService {
		if (!this.instance) this.instance = new ChatPubSubService();
		return this.instance;
	}

	private subscriber: Redis | null = null;
	private refs = new Map<string, number>();
	private readonly engine = WebsocketEngine.getInstance();
	private readonly log = serviceLogger("ChatPubSub");

	private constructor() {}

	static channelFor = (userId: number) => `chat:user:${userId}`;

	private ensureSubscriber = async () => {
		if (this.subscriber) return;
		const client = CacheService.getInstance().getRedisClient();
		/* @info - Disable ioredis's INFO ready-check on the duplicate: subscribe()
		 * flips the connection to subscriber mode immediately, so the internal
		 * ready-check would run INFO and crash with "only P|S)SUBSCRIBE allowed". */
		this.subscriber = client.duplicate({ enableReadyCheck: false }) as Redis;
		this.subscriber.on("message", (channel, message) => {
			const userId = Number(channel.split(":")[2]);
			if (!userId) return;
			try {
				this.engine.send(userId, JSON.parse(message));
			} catch {
				this.engine.send(userId, message);
			}
		});
		this.subscriber.on("error", (err) => {
			this.log.warn(`Chat pub/sub error: ${err instanceof Error ? err.message : String(err)}`);
		});
	};

	/** Subscribe a user's channel (ref-counted per process; first socket subscribes). */
	subscribeUser = async (userId: number) => {
		await this.ensureSubscriber();
		const channel = ChatPubSubService.channelFor(userId);
		const refs = this.refs.get(channel) ?? 0;
		if (refs === 0) {
			await this.subscriber!.subscribe(channel);
			this.log.info(`Subscribed ${channel}`);
		}
		this.refs.set(channel, refs + 1);
	};

	/** Unsubscribe a user's channel when their last socket on this process closed. */
	unsubscribeUser = async (userId: number) => {
		const channel = ChatPubSubService.channelFor(userId);
		const refs = this.refs.get(channel) ?? 0;
		if (refs <= 0) return;
		if (refs === 1) {
			await this.subscriber?.unsubscribe(channel);
			this.log.info(`Unsubscribed ${channel}`);
			this.refs.delete(channel);
		} else {
			this.refs.set(channel, refs - 1);
		}
	};

	/** Publish a chat envelope to one user's channel. */
	publishUser = async (userId: number, envelope: unknown) => {
		const client = CacheService.getInstance().getRedisClient();
		await client.publish(ChatPubSubService.channelFor(userId), JSON.stringify(envelope));
	};
}
