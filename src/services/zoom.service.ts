import axios from "axios";
import { ApiService } from "./api.service";
import { serviceLogger } from "@/utils";
import { config } from "@/config";

export interface ZoomPaths {
	CREATE_MEETING: "/users/me/meetings";
}

export interface CreateZoomMeetingOptions {
	topic: string;
	agenda?: string;
	startTime: string;
	duration: number;
	attendees?: string[];
	autoRecord?: boolean;
}

export interface ZoomMeetingResult {
	meetingId: number;
	joinUrl: string;
	startUrl: string;
}

export class ZoomService {
	private static instance: ZoomService;
	private readonly log = serviceLogger("Zoom");
	private api: ApiService<ZoomPaths>;
	private accessToken: string | null = null;
	private tokenExpiry = 0;

	static getInstance(): ZoomService {
		if (!this.instance) this.instance = new ZoomService();
		return this.instance;
	}

	private constructor() {
		this.api = new ApiService<ZoomPaths>("https://api.zoom.us/v2", {
			headers: { "Content-Type": "application/json" },
		});
	}

	private async getAccessToken(): Promise<string> {
		if (this.accessToken && Date.now() < this.tokenExpiry) {
			return this.accessToken as string;
		}

		const { accountId, clientId, clientSecret } = config.zoom;
		const authString = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
		const url = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountId}`;

		try {
			const response = await axios.post(url, null, {
				headers: { Authorization: `Basic ${authString}` },
			});

			this.accessToken = response.data.access_token;
			this.tokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;
			this.log.info("Zoom access token obtained");
			return this.accessToken as string;
		} catch (error: any) {
			const cause = error?.cause;
			const causeInfo = cause
				? ` | cause: ${cause.message ?? cause}${
						cause.code ? ` (code: ${cause.code})` : ""
					}`
				: "";
			this.log.error(
				`Failed to obtain Zoom access token: ${error.message}${causeInfo}`,
			);
			throw new Error("Zoom authentication failed");
		}
	}

	async createMeeting(options: CreateZoomMeetingOptions): Promise<ZoomMeetingResult> {
		const token = await this.getAccessToken();

		const meetingData = {
			topic: options.topic,
			type: 2,
			start_time: options.startTime,
			duration: options.duration,
			agenda: options.agenda,
			settings: {
				join_before_host: true,
				waiting_room: false,
				auto_record: options.autoRecord ? "cloud" : "none",
			},
		};

		try {
			const response = await this.api.post<{
				id: number;
				join_url: string;
				start_url: string;
			}>("/users/me/meetings", meetingData, {
				headers: { Authorization: `Bearer ${token}` },
			});

			const { id, join_url, start_url } = response.data;
			this.log.info("Zoom meeting created", {
				meetingId: id,
				topic: options.topic,
				autoRecord: options.autoRecord || false,
			});

			return {
				meetingId: id,
				joinUrl: join_url,
				startUrl: start_url,
			};
		} catch (error: any) {
			const cause = error?.cause;
			const causeInfo = cause
				? ` | cause: ${cause.message ?? cause}${
						cause.code ? ` (code: ${cause.code})` : ""
					}${cause.detail ? ` detail: ${cause.detail}` : ""}`
				: "";
			this.log.error(
				`Failed to create Zoom meeting: ${error.message}${causeInfo}`,
			);
			throw new Error("Could not create Zoom meeting");
		}
	}
}
