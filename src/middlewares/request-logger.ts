import chalk from "chalk";
import type { Context, Next } from "hono";

export const RequestLogger = async (c: Context, next: Next) => {
	const startTime = performance.now();
	const { method, url } = c.req;
	const METHOD = method.toUpperCase();
	const PATH = url;

	// @ts-ignore
	const COLORIZE = (text: string, color: string) => ` ${chalk[color](text)} `;

	await next();

	const endTime = performance.now();
	const duration = Math.round(endTime - startTime);
	const TIME = `${duration}ms`;

	switch (METHOD) {
		case "GET":
			console.log(
				chalk.bgGreen(COLORIZE(METHOD, "white")) +
					COLORIZE(PATH, "white") +
					COLORIZE(TIME, "green"),
			);
			break;
		case "POST":
			console.log(
				chalk.bgYellow(COLORIZE(METHOD, "white")) +
					COLORIZE(PATH, "white") +
					COLORIZE(TIME, "yellow"),
			);
			break;
		case "DELETE":
			console.log(
				chalk.bgRed(COLORIZE(METHOD, "white")) +
					COLORIZE(PATH, "white") +
					COLORIZE(TIME, "red"),
			);
			break;
		case "PUT":
		case "PATCH":
			console.log(
				chalk.bgBlue(COLORIZE(METHOD, "white")) +
					COLORIZE(PATH, "white") +
					COLORIZE(TIME, "blue"),
			);
			break;
		default:
			console.log(
				chalk.bgGray(COLORIZE(METHOD, "white")) +
					COLORIZE(PATH, "white") +
					COLORIZE(TIME, "gray"),
			);
	}
};
