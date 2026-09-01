import type { Context, Next } from "hono";

export const healthCheck = (c: Context) => {
	return c.json({
		success: true,
		message: "Hello! hive backend active!👋",
		author: "sp3c7r4 <sp3c7r40x00@gmail.com> ⚡",
		version: "1.0.0",
	});
};

export const serviceHealthCheck = (serviceName: string) => {
	return (c: Context, _: Next) => {
		return c.json({
			success: true,
			message: `${serviceName} is healthy!`,
		});
	};
	// next();
};
