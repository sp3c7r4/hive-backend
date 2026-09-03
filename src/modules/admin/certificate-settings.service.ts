/**
 * @info - Certificate director settings backed by platform_settings.
 * DB wins over the env fallback (config.certificates.*).
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import { config } from "@/config";
import { throwBadRequestError } from "@/helpers/errors/throw-errors";
import { platformSettings } from "./platform-setting.model";

export const DIRECTOR_NAME_KEY = "cert.directorName";
export const DIRECTOR_SIGNATURE_KEY = "cert.directorSignature";

export interface CertificateSettings {
	directorName: string;
	directorSignature: string;
}

export class CertificateSettingsService {
	private static instance: CertificateSettingsService;

	static getInstance(): CertificateSettingsService {
		if (!this.instance) this.instance = new CertificateSettingsService();
		return this.instance;
	}

	/** @info - DB value when set, otherwise the env/deploy fallback */
	get = async (): Promise<CertificateSettings> => {
		const db = getDb();
		const rows = await db
			.select({ key: platformSettings.key, value: platformSettings.value })
			.from(platformSettings)
			.where(
				sql`${platformSettings.key} IN (${DIRECTOR_NAME_KEY}, ${DIRECTOR_SIGNATURE_KEY})`,
			);
		const map = new Map(rows.map((r) => [r.key, r.value]));
		return {
			directorName:
				map.get(DIRECTOR_NAME_KEY)?.trim() ||
				config.certificates.directorName,
			directorSignature:
				map.get(DIRECTOR_SIGNATURE_KEY)?.trim() ||
				config.certificates.directorSignature ||
				"",
		};
	};

	/** @info - Upsert both keys. Empty signature clears it (cert renders
	 * name-only via the template guard). */
	update = async (input: {
		directorName?: string;
		directorSignature?: string;
	}): Promise<CertificateSettings> => {
		const db = getDb();
		if (input.directorName !== undefined) {
			const name = input.directorName.trim();
			if (!name || name.length > 120) {
				throwBadRequestError(
					"Director name must be between 1 and 120 characters.",
				);
			}
			await this._upsert(db, DIRECTOR_NAME_KEY, name);
		}
		if (input.directorSignature !== undefined) {
			await this._upsert(
				db,
				DIRECTOR_SIGNATURE_KEY,
				input.directorSignature.trim(),
			);
		}
		return this.get();
	};

	private _upsert = async (
		db: ReturnType<typeof getDb>,
		key: string,
		value: string,
	) => {
		await db
			.insert(platformSettings)
			.values({ key, value } as any)
			.onConflictDoUpdate({
				target: platformSettings.key,
				set: {
					value,
					updatedAt: new Date(),
				},
			});
	};
}
