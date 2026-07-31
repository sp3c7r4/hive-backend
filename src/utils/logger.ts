import path from "node:path";
import chalk from "chalk";
import { createLogger, format, transports } from "winston";
import { config } from "@/config";
import { LoggerLevels } from "@/enums";

const colorize = format.printf(
	({ level, message, timestamp, service, ...meta }) => {
		const color =
			level === LoggerLevels.ERROR
				? "red"
				: level === LoggerLevels.WARN
					? "yellow"
					: level === LoggerLevels.INFO
						? "green"
						: level === LoggerLevels.DEBUG
							? "cyan"
							: "white";
		const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
		return `${timestamp} ${chalk[color](level)}: ${chalk[color](message)}${extra}`;
	},
);

const plainTextFormat = format.printf(
	({ level, message, timestamp, service, ...meta }: any) => {
		const base = `${timestamp} ${level} ${service ? `[${service.toUpperCase()}]` : ""}: ${message}`;
		const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
		return base + extra;
	},
);

const env = config.env.trim() || "development";
const logFileName = `${env.trim()}.combined.log`;
const errorLogFileName = `${env.trim()}.error.log`;

export const logger = createLogger({
	level: LoggerLevels.DEBUG,
	format: format.combine(format.timestamp(), format.simple()),
	transports: [
		new transports.Console({
			format: format.combine(format.timestamp(), colorize),
		}),
		new transports.File({
			filename: path.resolve(process.cwd(), "logs", "errors", errorLogFileName),
			level: LoggerLevels.ERROR,
			format: format.combine(format.timestamp(), plainTextFormat),
		}),
		new transports.File({
			filename: path.resolve(process.cwd(), "logs", "global", logFileName),
			format: format.combine(format.timestamp(), plainTextFormat),
		}),
	],
});

export const serviceLogger = (serviceName: string) => {
	return logger.child({ service: serviceName });
};
