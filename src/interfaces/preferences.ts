export interface IUserPreferences {
	theme: "light" | "dark" | "system";
	locale: string;
	timezone: string;
	notifications: {
		email: boolean;
		sms: boolean;
		whatsapp: boolean;
		push: boolean;
	};
}
