import { env } from "./env";

export const config = {
	jwt: {
		privateKey: env.JWT_PRIVATE_KEY,
		publicKey: env.JWT_PUBLIC_KEY,
		expiresIn: env.JWT_EXPIRES_IN,
		issuer: env.JWT_ISSUER,
	},

	db: {
		uri: env.POSTGRES_URI,
		name: env.POSTGRES_DB_NAME,
		user: env.POSTGRES_USER,
		password: env.POSTGRES_PASSWORD,
		host: env.POSTGRES_HOST,
		port: env.POSTGRES_PORT,
	},

	mail: {
		domain: env.MAIL_DOMAIN,
	},

	redis: {
		uri: env.REDIS_URI,
	},

	server: {
		hostname: env.HOSTNAME,
		port: env.PORT,
		serverDomain: env.SERVER_DOMAIN,
		rootDomain: env.ROOT_DOMAIN,
		origins: env.ORIGINS,
		logo: {
			dark: env.DARK_LOGO,
			light: env.LIGHT_LOGO,
		},
	},
	frontendUrl: env.FRONTEND_URL,

	encryption: {
		key: env.ENCRYPTION_KEY,
	},

	aws: {
		region: env.AWS_REGION,
		accessKeyId: env.AWS_ACCESS_KEY_ID,
		secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
		bedrockApiKey: env.AWS_BEDROCK_API_KEY,
		s3Bucket: env.AWS_S3_BUCKET,
		s3Url: `https://${env.AWS_S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/`,
		s3Endpoint: env.AWS_S3_ENDPOINT,
		resend: {
			apiKey: env.RESEND_API_KEY,
			domain: env.RESEND_DOMAIN,
		},
	},

	google: {
		clientId: env.GOOGLE_CLIENT_ID,
		clientSecret: env.GOOGLE_CLIENT_SECRET,
		redirectUri: env.GOOGLE_REDIRECT_URI,
		refreshToken: env.GOOGLE_REFRESH_TOKEN,
	},

	zoom: {
		accountId: env.ZOOM_ACCOUNT_ID,
		clientId: env.ZOOM_CLIENT_ID,
		clientSecret: env.ZOOM_CLIENT_SECRET,
	},

	github: {
		clientId: env.GITHUB_CLIENT_ID,
		clientSecret: env.GITHUB_CLIENT_SECRET,
	},

	telegram: {
		apiId: env.TELEGRAM_API_ID,
		apiHash: env.TELEGRAM_API_HASH,
	},

	facebook: {
		clientId: env.FACEBOOK_CLIENT_ID,
		clientSecret: env.FACEBOOK_CLIENT_SECRET,
		configId: env.FACEBOOK_CONFIG_ID,
	},

	paystack: {
		secret: env.PAYSTACK_SECRET_KEY,
		devResolveFallback: env.PAYSTACK_DEV_RESOLVE_FALLBACK === "true",
	},

	ai: {
		apiKey: env.OPENAI_API_KEY,
		models: {
			ZEUS: env.ZEUS,
			ATHENA: env.ATHENA,
		},
	},

	env: env.NODE_ENV,
	getEnvUrl: () => {
		return config.env === "development"
			? `http://127.0.0.1:${config.server.port}`
			: `https://${config.server.serverDomain}`;
	},
};
