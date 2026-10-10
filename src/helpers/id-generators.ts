import { webcrypto } from "node:crypto";
import { nanoid } from "nanoid";
import { v4 } from "uuid";

/** @info - Lock key generator */
export const generateLockKey = (idempotencyKey: string) => {
	return `job:lock:${idempotencyKey}`;
};

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

/**
 * @info - Media keys are `<class>/<owner>/<unique>-<timestamp>.<ext>`: the first
 * segment names the media class (images, videos, documents, certificates), so a
 * lifecycle, cache or retention rule can be aimed at a prefix later. The owner
 * is the uploader's id, which keeps one user's objects together.
 */
export const generateMediaKey = (
	prefix: string,
	ext: string,
	userId?: string,
) => {
	const timestamp = Date.now();
	const uniqueId = nanoid();
	return `${prefix}/${userId || "general"}/${uniqueId}-${timestamp}.${ext}`;
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
