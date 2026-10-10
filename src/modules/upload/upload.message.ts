/**
 * @info - User-facing strings for the upload paths. The image derivative answer
 * names what to do rather than what failed internally, because the person
 * reading it is an instructor who just picked a file.
 */
export const UPLOAD_MESSAGES = {
	UNREADABLE_IMAGE:
		"That image could not be read. Try a JPEG, PNG or WebP under 5 MB.",
	FOLDER_NOT_ALLOWED: "Unknown upload folder",
} as const;
