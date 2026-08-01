import { google, calendar_v3 } from "googleapis";
import { serviceLogger } from "@/utils";
import { config } from "@/config";

export interface CreateCalendarEventOptions {
	summary: string;
	description?: string;
	location?: string;
	startTime: string;
	endTime: string;
	attendees?: string[];
	generateMeetLink?: boolean;
	externalVideoLink?: string;
}

export interface CalendarEventResult {
	eventId: string;
	hangoutLink?: string;
	htmlLink: string;
}

export class GoogleCalendarService {
	private static instance: GoogleCalendarService;
	private readonly log = serviceLogger("Google Calendar");
	private calendar: calendar_v3.Calendar;

	static getInstance(): GoogleCalendarService {
		if (!this.instance) this.instance = new GoogleCalendarService();
		return this.instance;
	}

	private constructor() {
		const auth = new google.auth.OAuth2(
			config.google.clientId,
			config.google.clientSecret,
			config.google.redirectUri,
		);

		if (config.google.refreshToken) {
			auth.setCredentials({ refresh_token: config.google.refreshToken });
		}

		this.calendar = google.calendar({ version: "v3", auth });
	}

	async createEvent(options: CreateCalendarEventOptions): Promise<CalendarEventResult> {
		const {
			summary,
			description,
			location,
			startTime,
			endTime,
			attendees,
			generateMeetLink = false,
			externalVideoLink,
		} = options;

		const event: calendar_v3.Schema$Event = {
			summary,
			description: externalVideoLink
				? `${description || ""}\n\nVideo link: ${externalVideoLink}`
				: description,
			location: location || externalVideoLink || undefined,
			start: { dateTime: startTime },
			end: { dateTime: endTime },
			attendees: attendees?.map((email) => ({ email })) || [],
		};

		if (generateMeetLink) {
			event.conferenceData = {
				createRequest: {
					requestId: `${Date.now()}-${Math.random()}`,
					conferenceSolutionKey: { type: "hangoutsMeet" },
				},
			};
		}

		try {
			const response = await this.calendar.events.insert({
				calendarId: "primary",
				requestBody: event,
				conferenceDataVersion: generateMeetLink ? 1 : 0,
				sendUpdates: "all",
			});

			this.log.info("Calendar event created", {
				eventId: response.data.id,
				summary,
				hasMeetLink: !!response.data.hangoutLink,
			});

			return {
				eventId: response.data.id!,
				hangoutLink: response.data.hangoutLink || undefined,
				htmlLink: response.data.htmlLink!,
			};
		} catch (error: any) {
			const cause = error?.cause;
			const causeInfo = cause
				? ` | cause: ${cause.message ?? cause}${
						cause.code ? ` (code: ${cause.code})` : ""
					}${cause.detail ? ` detail: ${cause.detail}` : ""}`
				: "";
			this.log.error(
				`Failed to create calendar event: ${error.message}${causeInfo}`,
			);
			throw new Error("Could not create calendar event");
		}
	}
}
