export enum ImageMimeType {
	JPEG = "image/jpeg",
	JPG = "image/jpg",
	PNG = "image/png",
	GIF = "image/gif",
	WEBP = "image/webp",
	SVG = "image/svg+xml",
	BMP = "image/bmp",
	TIFF = "image/tiff",
	AVIF = "image/avif",
	HEIC = "image/heic",
	HEIF = "image/heif",
}

export enum VideoMimeType {
	MP4 = "video/mp4",
	WEBM = "video/webm",
	OGG = "video/ogg",
	QUICKTIME = "video/quicktime",
	AVI = "video/x-msvideo",
	MATROSKA = "video/x-matroska",
	MPEG = "video/mpeg",
	THREE_GPP = "video/3gpp",
}

export enum AudioMimeType {
	MPEG = "audio/mpeg",
	WAV = "audio/wav",
	OGG = "audio/ogg",
	WEBM = "audio/webm",
	AAC = "audio/aac",
	FLAC = "audio/flac",
	M4A = "audio/x-m4a",
	MP4 = "audio/mp4",
}

export enum DocumentMimeType {
	PDF = "application/pdf",
	DOC = "application/msword",
	DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	XLS = "application/vnd.ms-excel",
	XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	PPT = "application/vnd.ms-powerpoint",
	PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	RTF = "application/rtf",
	TXT = "text/plain",
	CSV = "text/csv",
	MARKDOWN = "text/markdown",
}

export enum ArchiveMimeType {
	ZIP = "application/zip",
	RAR = "application/x-rar-compressed",
	SEVEN_ZIP = "application/x-7z-compressed",
	GZIP = "application/gzip",
	TAR = "application/x-tar",
}

export enum FontMimeType {
	WOFF = "font/woff",
	WOFF2 = "font/woff2",
	TTF = "font/ttf",
	OTF = "font/otf",
	EOT = "application/vnd.ms-fontobject",
}

export enum ImageExtension {
	JPG = ".jpg",
	JPEG = ".jpeg",
	PNG = ".png",
	GIF = ".gif",
	WEBP = ".webp",
	SVG = ".svg",
	BMP = ".bmp",
	TIFF = ".tiff",
	TIF = ".tif",
	AVIF = ".avif",
	HEIC = ".heic",
	HEIF = ".heif",
}

export enum VideoExtension {
	MP4 = ".mp4",
	WEBM = ".webm",
	OGV = ".ogv",
	MOV = ".mov",
	AVI = ".avi",
	MKV = ".mkv",
	MPEG = ".mpeg",
	THREE_GP = ".3gp",
}

export enum AudioExtension {
	MP3 = ".mp3",
	WAV = ".wav",
	OGG = ".ogg",
	WEBM = ".webm",
	AAC = ".aac",
	FLAC = ".flac",
	M4A = ".m4a",
}

export enum DocumentExtension {
	PDF = ".pdf",
	DOC = ".doc",
	DOCX = ".docx",
	XLS = ".xls",
	XLSX = ".xlsx",
	PPT = ".ppt",
	PPTX = ".pptx",
	RTF = ".rtf",
	TXT = ".txt",
	CSV = ".csv",
	MD = ".md",
}

export enum ArchiveExtension {
	ZIP = ".zip",
	RAR = ".rar",
	SEVEN_Z = ".7z",
	GZ = ".gz",
	TAR = ".tar",
}

export enum FontExtension {
	WOFF = ".woff",
	WOFF2 = ".woff2",
	TTF = ".ttf",
	OTF = ".otf",
	EOT = ".eot",
}

export type AllowedMimeType =
	| ImageMimeType
	| VideoMimeType
	| AudioMimeType
	| DocumentMimeType
	| ArchiveMimeType
	| FontMimeType;

export const ALL_ALLOWED_TYPES: readonly AllowedMimeType[] = [
	...Object.values(ImageMimeType),
	...Object.values(VideoMimeType),
	...Object.values(AudioMimeType),
	...Object.values(DocumentMimeType),
	...Object.values(ArchiveMimeType),
	...Object.values(FontMimeType),
] as const;
