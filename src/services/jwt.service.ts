import type { Context, HonoRequest, Next } from "hono";
import type { WSContext } from "hono/ws";
import { StatusCodes } from "http-status-codes";
/** @info - CJS Modules */
import jwt from "jsonwebtoken";
import { config } from "@/config";
import { TTL } from "@/constants";
import { JwtAction } from "@/enums";
import { throwUnauthorizedError } from "@/helpers/errors";
import { grabUserIdFromAuthId } from "@/helpers/id-generators";
import { sendWsErrorResponse } from "@/helpers/response";
import type { IAuthData, IJwtPayload } from "@/interfaces";
import { CacheService } from "./cache.service";

const { JsonWebTokenError, sign, verify, TokenExpiredError } = jwt;

export class JwtService {
	static instance: JwtService;

	/** @info - Services */
	private cacheService: CacheService;

	/**
	 * @info - Gets Singleton instance
	 * @returns {JwtService}
	 */
	static getInstance(): JwtService {
		if (!this.instance) {
			this.instance = new JwtService();
		}
		return this.instance;
	}

	/** @private */
	constructor() {
		this.cacheService = CacheService.getInstance();
	}

	generateToken = (
		authId: string,
		expiresIn: number = TTL.IN_30_MINUTES,
	): string => {
		return sign({ authId }, config.jwt.privateKey, {
			expiresIn: expiresIn ?? config.jwt.expiresIn,
			issuer: config.jwt.issuer,
			algorithm: "RS256",
		});
	};

	generateTokenFromPayload = (
		payload: Record<string, any> | string,
		expiresIn: number,
	) => {
		return sign(payload, config.jwt.privateKey, {
			expiresIn: expiresIn ?? config.jwt.expiresIn,
			issuer: config.jwt.issuer,
			algorithm: "RS256",
		}) as string;
	};

	verifyToken = <T extends IJwtPayload>(token: string) => {
		return verify(token, config.jwt.publicKey, {
			algorithms: ["RS256"],
		}) as T;
	};

	private extractTokenFromHeader = (req: HonoRequest): string | undefined => {
		const [type, token] = req.header("Authorization")?.split(" ") ?? [];
		return type === "Bearer" ? token : undefined;
	};

	validateToken = async (c: Context, next: Next) => {
		try {
			const token = this.extractTokenFromHeader(c.req);

			if (!token)
				return throwUnauthorizedError(
					"Token not found. Please ensure Bearer token is provided.",
				);

			const decoded = this.verifyToken<IJwtPayload>(token);

			const data = await this.cacheService.get<IAuthData>(decoded.authId);

			if (!data) {
				/* @info - Session revoked. If a suspension marker exists for this
				 * user, tell them (and the client) it's a suspension, not a logout. */
				const userId = grabUserIdFromAuthId(decoded.authId);
				if (userId) {
					const marker = await this.cacheService.redis.get(`suspended:${userId}`);
					if (marker) {
						return throwUnauthorizedError(
							"This account is suspended. Contact support.",
						);
					}
				}
				return throwUnauthorizedError("Unauthorized");
			}

			if (
				data.action &&
				!Object.values(JwtAction).includes(data.action) &&
				!data.isAuthenticated
			) {
				throwUnauthorizedError("Something went wrong, please try again.");
			}

			c.set("authData", { ...data, authId: decoded.authId });
			await next();
		} catch (e: any) {
			if (e instanceof TokenExpiredError) {
				throwUnauthorizedError("Token expired");
			} else if (e instanceof JsonWebTokenError) {
				throwUnauthorizedError("Invalid token");
			} else {
				throwUnauthorizedError(e?.message || "Unauthorized");
			}
		}
	};

	validateWebsocketToken = async (
		ws: WSContext<any>,
		token: string,
	): Promise<IAuthData | any> => {
		try {
			if (!token)
				return sendWsErrorResponse(
					ws,
					"Token not found. Please provide token as query parameter.",
					StatusCodes.BAD_REQUEST,
				);

			const decoded = this.verifyToken<IJwtPayload>(token);

			const data = await this.cacheService.get<IAuthData>(decoded.authId);

			if (!data)
				return sendWsErrorResponse(
					ws,
					"Unauthorized",
					StatusCodes.UNAUTHORIZED,
				);

			if (
				data.action &&
				!Object.values(JwtAction).includes(data.action) &&
				!data.isAuthenticated
			) {
				return sendWsErrorResponse(
					ws,
					"Something went wrong, please try again.",
					StatusCodes.BAD_REQUEST,
				);
			}

			return data;
		} catch (e: any) {
			if (e instanceof TokenExpiredError) {
				return sendWsErrorResponse(
					ws,
					"Token expired",
					StatusCodes.REQUEST_TIMEOUT,
				);
			} else if (e instanceof JsonWebTokenError) {
				return sendWsErrorResponse(
					ws,
					"Invalid token",
					StatusCodes.BAD_REQUEST,
				);
			} else {
				return sendWsErrorResponse(
					ws,
					e?.message || "Unauthorized",
					StatusCodes.UNAUTHORIZED,
				);
			}
		}
	};
}
