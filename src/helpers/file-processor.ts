import { Readable } from "node:stream";
import csv from "csv-parser";
import _ from "lodash";
import * as XLSX from "xlsx";
import { serviceLogger } from "@/utils";
import { throwBadRequestError } from "./errors";

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

const log = serviceLogger("File Processor");

export function CSVProcessor<T extends Record<string, any>>(
	options: CSVProcessorOptions,
): Promise<T[]> {
	return new Promise((res, rej) => {
		const records: T[] = [];
		let headerChecked = false;

		/**
		 * @info - Only pass explicit headers to csv-parser when the file has
		 * NO header row of its own (headerEnabled: false — positional mapping).
		 * When headerEnabled is true, let csv-parser read the file's real
		 * header line as usual so we can validate it against `options.headers`.
		 */
		const stream = Readable.from(options.file).pipe(
			csv(options.headerEnabled === false ? { headers: options.headers } : {}),
		);

		stream.on("data", (row: Record<string, any>) => {
			if (options.headerEnabled && !headerChecked) {
				headerChecked = true;

				const actualHeaders = Object.keys(row);
				const missing = _.difference(options.headers, actualHeaders);
				const unexpected = _.difference(actualHeaders, options.headers);

				if (missing.length > 0 || unexpected.length > 0) {
					stream.destroy();
					try {
						throwBadRequestError(
							`Invalid CSV headers. Missing: [${missing.join(", ")}], Unexpected: [${unexpected.join(", ")}]`,
						);
					} catch (error) {
						return rej(error);
					}
					return;
				}
			}

			records.push(row as T);
		});

		stream.on("error", (error) => {
			log.error("Failed to process CSV", error);
			try {
				throwBadRequestError("Invalid or corrupted CSV file.");
			} catch (e) {
				return rej(e);
			}
		});

		stream.on("end", () => {
			log.info("CSV data processed successfully.");
			return res(records);
		});
	});
}

export async function XLSXProcessor<T extends Record<string, any>>(
	options: XLSXProcessorOptions,
): Promise<T[]> {
	try {
		const workbook = XLSX.read(options.file, {
			type: "buffer",
			cellDates: true,
		});

		const sheetName = workbook.SheetNames[0];
		if (!sheetName) return throwBadRequestError("Uploaded file has no sheets.");
		const sheet = workbook.Sheets[sheetName];

		/**
		 * @info - headerEnabled: false means the file has no header row of its
		 * own — we impose `options.headers` positionally as the column keys.
		 * Otherwise, sheet_to_json reads the file's real first row as headers,
		 * which we validate below.
		 */
		const records = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, {
			defval: null, // keep every key present even on sparsely-filled rows
			...(options.headerEnabled === false ? { header: options.headers } : {}),
		});

		if (options.headerEnabled) {
			const actualHeaders = records.length > 0 ? Object.keys(records[0]) : [];
			const missing = _.difference(options.headers, actualHeaders);
			const unexpected = _.difference(actualHeaders, options.headers);

			if (missing.length > 0 || unexpected.length > 0) {
				return throwBadRequestError(
					`Invalid XLSX headers. Missing: [${missing.join(", ")}], Unexpected: [${unexpected.join(", ")}]`,
				);
			}
		}

		log.info("XLSX data processed successfully.");
		return records as T[];
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.error("Failed to process XLSX", message);
		return throwBadRequestError(message);
	}
}

// import { readFileSync } from "node:fs";

// const students = readFileSync("./students.csv"); // already a Buffer, no need to wrap
// const data = await CSVProcessor<{
// 	name: string;
// 	age: string;
// 	matric_no: string;
// }>({
// 	file: students,
// 	headerEnabled: true,
// 	headers: ["name", "age", "matric_no"],
// });
// console.log(data);

// import { readFileSync } from "node:fs";

// const studentsx = readFileSync("./students.xlsx");
// const datax = await XLSXProcessor<{
// 	name: string;
// 	age: number;
// 	matric_no: string;
// }>({
// 	file: studentsx,
// 	headerEnabled: true,
// 	headers: ["name", "age", "matric_no"],
// });
// console.log(datax);
