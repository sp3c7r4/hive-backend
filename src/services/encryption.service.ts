import { hash, verify } from "@node-rs/argon2";
import CryptoJS from "crypto-js";
import { config } from "@/config";
import { Algorithm, MEMORY_COST, PARALLELISM, TIME_COST } from "@/constants";

export class EncryptionService {
	private static instance: EncryptionService;
	private readonly secretKey = config.encryption.key;

	/** @private */
	private constructor() {}

	/** @returns {EncryptionService} */
	static getInstance(): EncryptionService {
		if (!this.instance) {
			this.instance = new EncryptionService();
		}
		return this.instance;
	}

	encrypt = (data: string): string => {
		return CryptoJS.AES.encrypt(data, this.secretKey).toString();
	};

	decrypt = (data: string): string => {
		return CryptoJS.AES.decrypt(data, this.secretKey).toString(
			CryptoJS.enc.Utf8,
		);
	};

	hash = async (password: string): Promise<string> => {
		return await hash(password, {
			memoryCost: MEMORY_COST,
			timeCost: TIME_COST,
			parallelism: PARALLELISM,
			algorithm: Algorithm.Argon2id,
		});
	};

	compare = async (password: string, hashedData: string): Promise<boolean> => {
		return await verify(hashedData, password);
	};
}
