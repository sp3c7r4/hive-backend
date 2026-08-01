import axios, {
	type AxiosInstance,
	type AxiosRequestConfig,
	type AxiosResponse,
	type CreateAxiosDefaults,
} from "axios";

export class ApiService<T extends Record<string, any>> {
	private api: AxiosInstance;

	constructor(
		baseUrl: string,
		config: Omit<CreateAxiosDefaults, "baseURL"> = {},
	) {
		this.api = axios.create({ baseURL: baseUrl, ...config });
	}

	get = async <R = unknown>(
		path: T[keyof T],
		config?: Omit<AxiosRequestConfig, "url">,
	): Promise<AxiosResponse<R>> => {
		return await this.api.get(path, config);
	};

	post = async <R = unknown>(
		path: T[keyof T],
		data?: any,
		config?: Omit<AxiosRequestConfig, "url">,
	): Promise<AxiosResponse<R>> => {
		return await this.api.post(path, data, config);
	};
}
