import type { Job } from "bullmq";
import { BaseWorkerService, RelationalRepository } from "@/bases";
import {
	ConnectionStatus,
	WhatsappJobNames,
	WhatsappNotifications,
	WhatsappQueueNames,
} from "@/enums";
import { generateConnectionNotificationId } from "@/helpers";
import { channelConnection } from "@/modules/channel/models/channel.connection.model";
import { BaileysEngine } from "@/services/engine/baileys.engine.service";
import { PublisherService } from "@/services/notification";
import { WhatsappMessageQueueService } from "@/services/queues/whatsapp-message.queue.service";

export class WhatsappConnectionWorkerService extends BaseWorkerService {
	private static instance: WhatsappConnectionWorkerService;

	private readonly publisherService: PublisherService;
	private readonly whatsappMessageQueueService: WhatsappMessageQueueService;
	private readonly connectionRepository = new RelationalRepository(
		channelConnection,
	);

	static getInstance() {
		if (!this.instance) this.instance = new WhatsappConnectionWorkerService();
		return this.instance;
	}

	private constructor() {
		super({
			queueName: WhatsappQueueNames.CONNECTION,
			alias: "WhatsappConnectionWorker",
			concurrency: 5,
		});
		this.publisherService = PublisherService.getInstance();
		this.whatsappMessageQueueService =
			WhatsappMessageQueueService.getInstance();
	}

	protected async process(job: Job) {
		const { connectionId, businessId, phoneNumber, pairingMethod, authId } =
			job.data;

		const channel = generateConnectionNotificationId(authId);

		await BaileysEngine.add({
			connectionId,
			phoneNumber,
			pairingMethod,
			businessId,

			onQR: async (qr: string) => {
				await this.publisherService.publish(
					channel,
					WhatsappNotifications.PAIRING_QR,
					qr,
				);
			},

			onPairingCode: async (code: string) => {
				await this.publisherService.publish(
					channel,
					WhatsappNotifications.PAIRING_CODE,
					code,
				);
			},

			onConnected: async () => {
				await this.connectionRepository.update(connectionId, {
					status: ConnectionStatus.CONNECTED,
					lastHeartbeat: new Date(),
				});
				await this.publisherService.publish(
					channel,
					WhatsappNotifications.CONNECTED,
					"WhatsApp connected successfully!",
				);
			},

			onReconnecting: async () => {
				await this.publisherService.publish(
					channel,
					WhatsappNotifications.RECONNECTING,
					"Connection interrupted. Reconnecting...",
				);
			},

			onDisconnected: async () => {
				await this.connectionRepository.update(connectionId, {
					status: ConnectionStatus.DISCONNECTED,
				});
				await this.publisherService.publish(
					channel,
					WhatsappNotifications.DISCONNECTED,
					"WhatsApp disconnected.",
				);
			},

			onMessage: (message: any) => {
				this.whatsappMessageQueueService.add(WhatsappJobNames.SEND_MESSAGE, {
					connectionId,
					...message,
				});
			},
		});
	}
}
