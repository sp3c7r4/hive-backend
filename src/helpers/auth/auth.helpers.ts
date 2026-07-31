import axios from "axios";
import _ from "lodash";
import { TTL } from "@/constants";
import type { UserTypes } from "@/enums";
import type { IAuthenticatedUser, IBaseUser } from "@/interfaces";
import { CacheService } from "@/services/cache.service";
import { JwtService } from "@/services/jwt.service";
import { generateRefreshTokenId, grabUserIdFromAuthId } from "../id-generators";

const isPrivateIP = (ip: string): boolean => {
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip.startsWith("192.168.") ||
    ip.startsWith("10.") ||
    ip.startsWith("172.16.") ||
    ip.startsWith("172.17.") ||
    ip.startsWith("172.18.") ||
    ip.startsWith("172.19.") ||
    ip.startsWith("172.20.") ||
    ip.startsWith("172.21.") ||
    ip.startsWith("172.22.") ||
    ip.startsWith("172.23.") ||
    ip.startsWith("172.24.") ||
    ip.startsWith("172.25.") ||
    ip.startsWith("172.26.") ||
    ip.startsWith("172.27.") ||
    ip.startsWith("172.28.") ||
    ip.startsWith("172.29.") ||
    ip.startsWith("172.30.") ||
    ip.startsWith("172.31.")
  );
};

export const getLocationFromIP = async (ip: string): Promise<string> => {
  try {
    if (isPrivateIP(ip)) return "Local Network";

    const { data } = await axios.get(`https://ipapi.co/${ip}/json/`, {
      timeout: 5000,
    });

    if (data.error) throw new Error(data.error);

    const city = data.city?.trim() || "";
    const country = data.country_name?.trim() || "";
    const location = [city, country].filter(Boolean).join(", ");

    return location || "Unknown Location";
  } catch (error: any) {
    console.error(`Failed to get location for IP ${ip}:`, error instanceof Error ? error.message : String(error));
    return "Unknown Location";
  }
};

export const generateAuthenticatedData = (
	modelData: Record<string, any> | IBaseUser,
): IAuthenticatedUser => {
	const data = {
		...modelData,
		isAuthenticated: true,
		authenticatedAt: new Date(),
	};
	console.log(data);
	return _.omit(data, ["hash"]) as IAuthenticatedUser;
};

export const generateAuthTokens = async (
	authId: string,
	userType: UserTypes,
) => {
	const cacheService = CacheService.getInstance();
	const jwtService = JwtService.getInstance();

	const userId = grabUserIdFromAuthId(authId);

	/** @info - Generate & store Refresh Token key */
	const refreshId = generateRefreshTokenId(userId);
	const refreshToken = jwtService.generateTokenFromPayload(
		{
			authId,
			refreshId,
			userType,
		},
		TTL.IN_7_DAYS,
	);
	await cacheService.set(refreshId, authId, TTL.IN_7_DAYS);

	const accessToken = jwtService.generateToken(authId);
	return { accessToken, refreshToken };
};
