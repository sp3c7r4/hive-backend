export const KEY_LENGTH = 512;
export const ITERATIONS = 10_000;
export const DIGEST = "sha512";
export const ENCODING = "hex";
export const SALT_ROUNDS: number = 10;

export const MEMORY_COST = 2 ** 16; // 64 MiB
export const TIME_COST = 3;
export const PARALLELISM = 1;

/** Algorithms */
export const Algorithm = {
	Argon2d: 0,
	Argon2i: 1,
	Argon2id: 2,
};
