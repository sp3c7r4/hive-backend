import { nanoid } from "nanoid";
import { v4 } from "uuid";
import { webcrypto } from "node:crypto";

/** @info - Lock key generator */
export const generateLockKey = (idempotencyKey: string) => {
  return `job:lock:${idempotencyKey}`
}

export const generateOTP = () => {
	return webcrypto.getRandomValues(new Uint32Array(1)).toString().slice(0, 6);
};

export const generateAuthId = (userId: string | number | null = null) => {
	return `auth:${userId || v4()}-${Date.now()}`;
};

export const generateWebsocketId = (userId: string | null = null) => {
	return `websocket:${userId || v4()}-${Date.now()}`;
};

export const generateOTPId = (userId: string | null = null) => {
	return `otp:${userId || v4()}-${Date.now()}`;
};

export const generateRefreshTokenId = (userId: string | null = null) => {
	return `refresh:${userId || v4()}-${Date.now()}`;
};

export const generateImageKey = (
	fileName: string,
	ext: string,
	userId?: string,
) => {
	const timestamp = Date.now();
	const uniqueId = nanoid();
	return `images/${fileName}/${userId || "general"}/${uniqueId}-${timestamp}.${ext}`;
};

export const grabUserIdFromAuthId = (authId: string) => {
	return authId.split(":")[1]!.split("-")[0];
};

export const generateBotId = (botId: number | string) => {
	return `bot:${botId}`;
};

export const generateChannelId = (channelId: number) => {
	return `channel:${channelId}`;
};

export const generateBusinessId = (businessId: number) => {
	return `business:${businessId}`;
};
