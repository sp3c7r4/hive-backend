export type InitEvent =
	| { type: "INIT_STARTED"; message: string }
	| { type: "CHECKING_COMMITS"; message: string }
	| { type: "FETCHING_REPO"; message: string }
	| { type: "REPO_FETCHED"; size: string; fileCount: number }
	| { type: "EXTRACTING"; message: string }
	| { type: "ANALYZING"; message: string; file: string; progress: number }
	| { type: "GENERATING_MD"; message: string }
	| { type: "MARKDOWN_READY"; preview: string; wordCount: number }
	| { type: "UPLOADING_S3"; message: string }
	| { type: "UPLOAD_COMPLETE"; version: string }
	| { type: "SAVING_DB"; message: string }
	| { type: "INIT_COMPLETE"; version: string }
	| { type: "INIT_ERROR"; message: string; details?: string };

export type TerraformEvent =
	| { type: "TF_STARTED"; command: string }
	| { type: "TF_OUTPUT"; line: string; isError: boolean }
	| { type: "TF_COMPLETE"; command: string }
	| { type: "TF_ERROR"; message: string };

export * from "./telegram.ws";
