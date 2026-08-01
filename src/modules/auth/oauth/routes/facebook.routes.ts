import { Hono } from "hono";
import { ZodEngine } from "@/services";
import { OAuthAuthenticateSchema } from "@/shared";
import { OauthController } from "../oauth.controller";

export const facebookRoute = new Hono({ strict: true });
const facebook = OauthController.getInstance().facebook;
const zodEngine = ZodEngine.getInstance();

facebookRoute.get(
	"/auth",
	zodEngine.validate.query(OAuthAuthenticateSchema),
	facebook.authenticate,
);

facebookRoute.get("/callback", facebook.callback);
