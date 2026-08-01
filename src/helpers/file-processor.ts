/**
 * CSV / XLSX file processors.
 *
 * Install dependencies when you need these:
 *   npm install csv-parser xlsx
 *   npm install -D @types/csv-parser
 */

import { Readable } from "node:stream";
import _ from "lodash";
import { serviceLogger } from "@/utils";
import { throwBadRequestError } from "./errors";

const log = serviceLogger("File Processor");

interface ProcessorOptions {
	file: Buffer;
}

type CSVProcessorOptions = ProcessorOptions &
	(
		| { headerEnabled: boolean; headers: string[] }
		| { headers?: never; headerEnabled?: never }
	);

type XLSXProcessorOptions = ProcessorOptions &
	(
		| { headerEnabled: boolean; headers: string[] }
		| { headers?: never; headerEnabled?: never }
	);

export async function CSVProcessor<T extends Record<string, any>>(
	_options: CSVProcessorOptions,
): Promise<T[]> {
	// TODO: Install csv-parser and implement:
	//   npm install csv-parser && npm install -D @types/csv-parser
	throw new Error("CSV processing not available. Install csv-parser: npm install csv-parser");
}

export async function XLSXProcessor<T extends Record<string, any>>(
	_options: XLSXProcessorOptions,
): Promise<T[]> {
	// TODO: Install xlsx and implement:
	//   npm install xlsx
	throw new Error("XLSX processing not available. Install xlsx: npm install xlsx");
}
