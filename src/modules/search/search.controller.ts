import type { Context } from "hono";
import { sendSuccessResponse } from "@/helpers";
import { SearchService } from "./search.service";

export class SearchController {
	private static instance: SearchController;
	private service: SearchService;

	static getInstance(): SearchController {
		if (!this.instance) this.instance = new SearchController();
		return this.instance;
	}

	private constructor() {
		this.service = SearchService.getInstance();
	}

	search = async (c: Context) => {
		const q = c.req.query("q") ?? "";
		const data = await this.service.search(q);
		return sendSuccessResponse(c, data);
	};
}
