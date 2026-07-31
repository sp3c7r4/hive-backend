import type { Job } from "bullmq";
import Redis from "ioredis";
import { BaseWorkerService } from "@/bases";
import {
	TelegramJobNames,
	TelegramNotifications,
	TelegramQueueNames,
} from "@/enums";
import { generateTelegramConnectionNotificationId } from "@/helpers";
import { CacheService } from "@/services/cache.service";
import type { TelegramConnectionOptions } from "@/services/engine/telegram.engine.service";
import { TelegramEngine } from "@/services/engine/telegram.engine.service";
import { PublisherService } from "@/services/notification";
import { TelegramMessageQueueService } from "@/services/queues/telegram-message.queue.service";

export class TelegramConnectionWorkerService extends BaseWorkerService {
	private static instance: TelegramConnectionWorkerService;

	private readonly publisherService: PublisherService;
	private readonly telegramMessageQueueService: TelegramMessageQueueService;
	private readonly cacheService: CacheService;

	static getInstance() {
		if (!this.instance) this.instance = new TelegramConnectionWorkerService();
		return this.instance;
	}

	private constructor() {
		super({
			queueName: TelegramQueueNames.CONNECTION,
			alias: "TelegramConnectionWorker",
			concurrency: 5,
			lockDuration: 300_000, // 5 minutes — auth flow can take a while
			maxStalledCount: 0, // Don't mark as stalled during interactive auth
		});
		this.publisherService = PublisherService.getInstance();
		this.telegramMessageQueueService =
			TelegramMessageQueueService.getInstance();
		this.cacheService = CacheService.getInstance();
	}

	protected async process(job: Job) {
		const { connectionId, businessId, pairingMethod, phoneNumber, authId } =
			job.data;

		/** @info - The Redis pub/sub channel the WebSocket handler is listening on */
		const channel = generateTelegramConnectionNotificationId(authId);
		const replyChannel = `${channel}:reply`;

		/** @info - Create a dedicated subscriber for client responses (OTP, 2FA) */
		const replySub = new Redis(this.cacheService.getRedisClient().options);

		try {
			// # Shared callbacks for both auth methods
			const onConnected = async () => {
				await this.publisherService.publish(
					channel,
					TelegramNotifications.CONNECTED,
					"Telegram account connected successfully!",
				);
			};

			const onDisconnected = async () => {
				await this.publisherService.publish(
					channel,
					TelegramNotifications.DISCONNECTED,
					"Telegram connection failed.",
				);
			};

			const onPasswordRequired = async () => {
				await this.publisherService.publish(
					channel,
					TelegramNotifications.PASSWORD_REQUIRED,
					"Enter your 2FA password",
				);
			};

			const onMessage = (message: any) => {
				this.telegramMessageQueueService.add(TelegramJobNames.SEND_MESSAGE, {
					connectionId,
					...message,
				});
			};

			/**
			 * @info - getPassword returns a promise that resolves when the client sends 2FA_PASSWORD
			 */
			const getPassword = (): Promise<string> => {
				return new Promise<string>((resolve) => {
					const handler = (_ch: string, msg: string) => {
						const { event, data } = JSON.parse(msg);
						if (event === "2FA_PASSWORD") {
							replySub.removeListener("message", handler);
							resolve(data);
						}
					};
					replySub.on("message", handler);
					replySub.subscribe(replyChannel);
					job.extendLock(job.token!, 300_000);
				});
			};

			let connectionOptions: TelegramConnectionOptions;

			if (pairingMethod === "qr") {
				// ──── QR Code Auth (Default) ────
				connectionOptions = {
					connectionId,
					businessId,
					pairingMethod: "qr",
					getPassword,
					onPasswordRequired,
					onConnected,
					onDisconnected,
					onMessage,
					onQrCode: async (qrUrl: string, expires: number) => {
						// # Publish QR code data as JSON string for the handler to parse
						await this.publisherService.publish(
							channel,
							TelegramNotifications.QR_CODE,
							JSON.stringify({ qrUrl, expires }),
						);
					},
				};
			} else {
				// ──── Phone + OTP Auth (Fallback) ────
				const getCode = (): Promise<string> => {
					return new Promise<string>((resolve) => {
						const handler = (_ch: string, msg: string) => {
							const { event, data } = JSON.parse(msg);
							if (event === "OTP_CODE") {
								replySub.removeListener("message", handler);
								resolve(data);
							}
						};
						replySub.on("message", handler);
						replySub.subscribe(replyChannel);
						job.extendLock(job.token!, 300_000);
					});
				};

				connectionOptions = {
					connectionId,
					businessId,
					pairingMethod: "phone",
					phoneNumber,
					getCode,
					getPassword,
					onCodeRequired: async () => {
						await this.publisherService.publish(
							channel,
							TelegramNotifications.CODE_REQUIRED,
							"Enter the OTP code sent to your Telegram app",
						);
					},
					onPasswordRequired,
					onConnected,
					onDisconnected,
					onMessage,
				};
			}

			await TelegramEngine.getInstance().add(connectionOptions);
		} finally {
			// # Clean up the reply subscriber gracefully
			try {
				await replySub.unsubscribe(replyChannel);
				await replySub.quit();
			} catch {
				// # Already closed — safe to ignore
			}
		}
	}
}
