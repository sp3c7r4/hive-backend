export interface IUserPreferences {
	theme: "light" | "dark" | "system";
	locale: string; // e.g., "en-US", "fr-FR"
	timezone: string; // e.g., "America/New_York", "Europe/Paris"
	notifications: {
		email: boolean; // General email notifications
		push: boolean; // Push notifications
		marketing: boolean; // Promotional emails, updates, etc.
		digest: "daily" | "weekly" | "none"; // Summary of activity, sent at specified intervals
	};
}
