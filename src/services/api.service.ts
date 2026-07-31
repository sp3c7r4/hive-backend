import axios, {
	type AxiosInstance,
	type AxiosRequestConfig,
	type AxiosResponse,
	type CreateAxiosDefaults,
} from "axios";

/**
 * @info - Api Service
 * E.g. const paystack = new ApiService<Paths>("https://api.paystack.co");
 * paystack.get(""/transaction/verify/:reference"")
 */
export class ApiService<T> {
	private api: AxiosInstance;

	constructor(
		baseUrl: string,
		config: Omit<CreateAxiosDefaults, "baseURL"> = {},
	) {
		this.api = axios.create({ baseURL: baseUrl, ...config });
	}

	get = async <R = unknown>(
		path: T[keyof T] extends string ? T[keyof T] : never,
		config?: Omit<AxiosRequestConfig, "url">,
	): Promise<AxiosResponse<R>> => {
		return await this.api.get(path, config);
	};

	post = async <R = unknown>(
		path: T[keyof T] extends string ? T[keyof T] : never,
		data?: any,
		config?: Omit<AxiosRequestConfig, "url">,
	): Promise<AxiosResponse<R>> => {
		return await this.api.post(path, data, config);
	};
}
