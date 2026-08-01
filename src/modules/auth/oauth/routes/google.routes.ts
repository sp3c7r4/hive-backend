import { Hono } from "hono";
import { ZodEngine } from "@/services";
import { OAuthAuthenticateSchema } from "@/shared";
import { OauthController } from "../oauth.controller";

export const googleRoute = new Hono({ strict: true });
const google = OauthController.getInstance().google;
const zodEngine = ZodEngine.getInstance();

googleRoute.get(
	"/auth",
	zodEngine.validate.query(OAuthAuthenticateSchema),
	google.authenticate,
);

googleRoute.get("/callback", google.callback);
