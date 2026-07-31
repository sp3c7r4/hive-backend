import Redis from "ioredis";
import { config } from "@/config";
import { TTL } from "@/constants";
import { logger } from "@/utils";

export class CacheService {
	private static instance: CacheService;
	readonly redis: Redis;

	static getInstance(): CacheService {
		if (!CacheService.instance) {
			CacheService.instance = new CacheService();
		}
		return CacheService.instance;
	}

	private constructor() {
		this.redis = new Redis(config.redis.uri, {
			connectTimeout: 10000,
			maxRetriesPerRequest: null, // I had to suite bullmq requirements
		});

		this.redis.on("error", (err) => {
			logger.error(`Redis connection error: ${err.message}`);
		});
	}

	public getRedisClient(): Redis {
		return this.redis;
	}

	public getConnectionOptions() {
		return {
			host: this.redis.options.host,
			port: this.redis.options.port,
			password: this.redis.options.password,
			maxRetriesPerRequest: null as null,
		};
	}

	set = async (
		key: string,
		value: any,
		ttl: number = TTL.IN_30_MINUTES,
	): Promise<void> => {
		await this.redis.set(key, JSON.stringify(value), "EX", ttl);
	};

	get = async <T>(key: string): Promise<T | null> => {
		const value = await this.redis.get(key);
		return value ? (JSON.parse(value) as T) : null;
	};

	hset = async (key: string, field: string, value: any): Promise<void> => {
		await this.redis.hset(key, field, JSON.stringify(value));
	};

	hget = async <T>(key: string, field: string): Promise<T | null> => {
		const value = await this.redis.hget(key, field);
		return value ? (JSON.parse(value) as T) : null;
	};

	delete = async (key: string): Promise<void> => {
		await this.redis.del(key);
	};

	deleteMany = async (keys: string[]): Promise<void> => {
		await this.redis.del(keys);
	};

	clear = async (): Promise<void> => {
		await this.redis.flushall();
	};

	close = async (): Promise<void> => {
		await this.redis.quit();
	};
}
