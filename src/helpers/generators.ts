import { webcrypto } from "node:crypto";

export const generateBase64 = (data: string): string => {
	return Buffer.from(data).toString("base64");
};

export const decodeBase64 = (data: string): string => {
	return Buffer.from(data, "base64").toString("utf-8");
};

export const generateRandomBytes = (length: number): Uint8Array => {
	return webcrypto.getRandomValues(new Uint8Array(length));
};
