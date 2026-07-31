import type { PaginatedResult } from "./pagination";

export interface IBaseRepository<T, TCreate = Omit<T, "id">> {
	findById(id: string | number): Promise<T | undefined>;
	findOne(filter: Partial<T>): Promise<T | undefined>;
	findMany(filter?: Partial<T>): Promise<T[]>;
	findPaginated(
		page: number,
		pageSize: number,
		filter?: Partial<T>,
	): Promise<PaginatedResult<T>>;
	create(data: TCreate): Promise<T>;
	createMany(data: TCreate[]): Promise<T[]>;
	update(id: string | number, data: Partial<TCreate>): Promise<T | undefined>;
	delete(id: string | number): Promise<boolean>;
	count(filter?: Partial<T>): Promise<number>;
	exists(filter: Partial<T>): Promise<boolean>;
}
