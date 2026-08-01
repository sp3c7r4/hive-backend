import { GoogleCalendarService } from "./google-calendar.service";
import { ZoomService } from "./zoom.service";
import { serviceLogger } from "@/utils";

export type MeetingProvider = "google" | "zoom";

export interface ScheduleMeetingOptions {
	provider: MeetingProvider;
	summary: string;
	description?: string;
	startTime: string;
	endTime: string;
	attendees?: string[];
	duration?: number;
	autoRecord?: boolean;
}

export interface ScheduleMeetingResult {
	provider: MeetingProvider;
	joinLink: string;
	calendarEventId: string;
	calendarHtmlLink: string;
}

export class MeetingSchedulerService {
	private static instance: MeetingSchedulerService;
	private readonly log = serviceLogger("Meeting Scheduler");
	private googleCalendar: GoogleCalendarService;
	private zoom: ZoomService;

	static getInstance(): MeetingSchedulerService {
		if (!this.instance) this.instance = new MeetingSchedulerService();
		return this.instance;
	}

	private constructor() {
		this.googleCalendar = GoogleCalendarService.getInstance();
		this.zoom = ZoomService.getInstance();
	}

	async scheduleMeeting(
		options: ScheduleMeetingOptions,
	): Promise<ScheduleMeetingResult> {
		const { provider, summary, description, startTime, endTime, attendees } =
			options;

		this.log.info("Scheduling meeting", {
			provider,
			summary,
			attendeeCount: attendees?.length || 0,
		});

		let joinLink: string;
		let calendarEventId: string;
		let calendarHtmlLink: string;
		let externalVideoLink: string | undefined;

		if (provider === "google") {
			const eventResult = await this.googleCalendar.createEvent({
				summary,
				description,
				startTime,
				endTime,
				attendees,
				generateMeetLink: true,
			});

			joinLink = eventResult.hangoutLink!;
			calendarEventId = eventResult.eventId;
			calendarHtmlLink = eventResult.htmlLink;

			this.log.info("Google Meet scheduled with calendar invite", { joinLink });
		} else if (provider === "zoom") {
			const duration = options.duration;
			if (!duration) {
				throw new Error("duration is required for Zoom meetings");
			}

			const zoomResult = await this.zoom.createMeeting({
				topic: summary,
				agenda: description,
				startTime,
				duration,
				attendees,
				autoRecord: options.autoRecord || false,
			});

			joinLink = zoomResult.joinUrl;
			externalVideoLink = zoomResult.joinUrl;

			const eventResult = await this.googleCalendar.createEvent({
				summary,
				description,
				startTime,
				endTime,
				attendees,
				generateMeetLink: false,
				externalVideoLink,
				location: joinLink,
			});

			calendarEventId = eventResult.eventId;
			calendarHtmlLink = eventResult.htmlLink;

			this.log.info("Zoom meeting scheduled with Google Calendar invite", {
				joinLink,
				autoRecord: options.autoRecord || false,
			});
		} else {
			throw new Error(`Unsupported provider: ${provider}`);
		}

		return {
			provider,
			joinLink,
			calendarEventId,
			calendarHtmlLink,
		};
	}
}
