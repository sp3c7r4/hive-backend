/**
 * @info - Google Drive share-link parsing. Ported from the original Hive
 * builder service: accepts any Google domain and /d/{id}/ or ?id= shapes.
 */

/** @info - Extract a Drive file ID from any share URL; null when not a Google domain */
export function extractDriveFileId(url: string): string | null {
	try {
		const u = new URL(url);
		if (!u.hostname.includes("google.com")) return null;
		const d = u.pathname.match(/\/d\/([^/]+)/);
		if (d?.[1]) return d[1];
		return u.searchParams.get("id");
	} catch {
		return null;
	}
}

export function isGoogleDriveLink(url: string): boolean {
	return extractDriveFileId(url) !== null;
}
