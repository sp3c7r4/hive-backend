import { config } from "@dotenvx/dotenvx";
import { z, ZodError } from "zod";

const getEnvFile = () => `.env.${process.env.NODE_ENV || "development"}`;
const envFile = getEnvFile();

config({ path: envFile, override: true });

const EnvSchema = z.object({
	PORT: z.coerce.number(),
	POSTGRES_DB_NAME: z.string(),
	POSTGRES_USER: z.string(),
	POSTGRES_PASSWORD: z.string(),
	POSTGRES_HOST: z.string(),
	POSTGRES_PORT: z.coerce.number(),
	POSTGRES_URI: z.string(),
	REDIS_URI: z.string(),
	HOSTNAME: z.string(),
	JWT_PRIVATE_KEY: z.string(),
	JWT_PUBLIC_KEY: z.string(),
	JWT_EXPIRES_IN: z.string(),
	JWT_ISSUER: z.string(),
	NODE_ENV: z.enum(["development", "production", "staging"]),
	SERVER_DOMAIN: z.string(),
	MAIL_DOMAIN: z.string(),
	ROOT_DOMAIN: z.string(),
	ORIGINS: z.string().transform((d) => {
		const parsed = JSON.parse(d);
		if (!Array.isArray(parsed)) throw new Error("ORIGINS must be an array");
		return parsed as string[];
	}),
	DARK_LOGO: z.url(),
	LIGHT_LOGO: z.url(),

	ENCRYPTION_KEY: z.string(),

	GOOGLE_CLIENT_ID: z.string(),
	GOOGLE_CLIENT_SECRET: z.string(),
	GOOGLE_REDIRECT_URI: z.string(),

	AWS_REGION: z.string(),
	AWS_ACCESS_KEY_ID: z.string(),
	AWS_SECRET_ACCESS_KEY: z.string(),
	AWS_BEDROCK_API_KEY: z.string(),
	AWS_S3_BUCKET: z.string(),
	AWS_S3_ENDPOINT: z.string().optional(),
	AWS_SES_SMTP_USER_NAME: z.string(),
	AWS_SES_SMTP_PASSWORD: z.string(),
	AWS_SES_SMTP_ENDPOINT: z.string(),
	AWS_SES_SMTP_PORT: z.string(),

	FACEBOOK_CLIENT_ID: z.string(),
	FACEBOOK_CLIENT_SECRET: z.string(),
	FACEBOOK_CONFIG_ID: z.string(),

	GITHUB_CLIENT_ID: z.string(),
	GITHUB_CLIENT_SECRET: z.string(),

	TELEGRAM_API_ID: z.coerce.number(),
	TELEGRAM_API_HASH: z.string(),

	PAYSTACK_SECRET_KEY: z.string(),
	/** @info - Dev-only: fake account resolution when Paystack test-mode cannot resolve */
	PAYSTACK_DEV_RESOLVE_FALLBACK: z.string().optional(),

	OPENAI_API_KEY: z.string(),

	ZEUS: z.string(),
	ATHENA: z.string(),

	ZOOM_ACCOUNT_ID: z.string().optional(),
	ZOOM_CLIENT_ID: z.string().optional(),
	ZOOM_CLIENT_SECRET: z.string().optional(),

	GOOGLE_REFRESH_TOKEN: z.string().optional(),
});

export type EnvType = z.infer<typeof EnvSchema>;

let _env: EnvType;

try {
	_env = EnvSchema.parse(process.env) as EnvType;
} catch (e) {
	if (e instanceof ZodError) {
		for (const issue of e.issues) {
			const key = issue.path.join(".");
			console.log(`❌ ${key} is missing or invalid: ${issue.message}`);
		}
	} else {
		const message = e instanceof Error ? e.message : String(e);
		console.log(`Error occurred: ${message}`);
	}
	process.exit(1);
}

export const env = _env!;

console.log("[ENV] using environment file:", envFile);
