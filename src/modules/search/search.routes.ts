import { Hono } from "hono";
import { JwtService } from "@/services";
import { SearchController } from "./search.controller";

const searchRouter = new Hono({ strict: true });
const controller = SearchController.getInstance();
const jwt = JwtService.getInstance();

searchRouter.use("*", jwt.validateToken);
searchRouter.get("/", controller.search);

export { searchRouter };
