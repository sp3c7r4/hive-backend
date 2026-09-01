/**
 * esbuild production bundler. Three custom plugins handle Node.js ESM edge cases.
 *
 * CUSTOMIZE_ME: Update asset copy list and entry points for your project.
 */

import { existsSync, statSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as esbuild from "esbuild";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));
const externals = [
	...Object.keys(pkg.dependencies || {}),
	...Object.keys(pkg.devDependencies || {}),
	...Object.keys(pkg.peerDependencies || {}),
];

const nodeRequire = createRequire(import.meta.url);

function resolveAlias(basePath: string, importPath: string, prefix: string) {
	const resolved = path.resolve(basePath, importPath.replace(prefix, ""));
	if (existsSync(resolved) && statSync(resolved).isDirectory()) {
		for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
			const indexPath = path.join(resolved, `index${ext}`);
			if (existsSync(indexPath)) return indexPath;
		}
	}
	for (const ext of [".ts", ".tsx", ".js", ".jsx", ""]) {
		const filePath = resolved + ext;
		if (existsSync(filePath)) return filePath;
	}
	return resolved;
}

const exportsFieldCache = new Map<string, boolean>();

function findPackageJsonPath(pkgName: string, startDir: string): string | null {
	let dir = startDir;
	while (true) {
		const candidate = path.join(dir, "node_modules", pkgName, "package.json");
		if (existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function packageHasExportsField(pkgName: string, fromDir: string): boolean {
	if (exportsFieldCache.has(pkgName)) return exportsFieldCache.get(pkgName)!;
	let hasExports = false;
	const pkgJsonPath = findPackageJsonPath(pkgName, fromDir);
	if (pkgJsonPath) {
		try {
			const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
			hasExports = Boolean(pkgJson.exports);
		} catch {
			hasExports = false;
		}
	}
	exportsFieldCache.set(pkgName, hasExports);
	return hasExports;
}

function fixExternalDirectoryImports(externalPkgs: string[]): esbuild.Plugin {
	return {
		name: "fix-external-directory-imports",
		setup(build) {
			build.onResolve({ filter: /.*/ }, (args) => {
				const matchedPkg = externalPkgs.find(
					(dep) => args.path === dep || args.path.startsWith(`${dep}/`),
				);
				if (!matchedPkg) return;

				if (args.path === matchedPkg) {
					return { path: args.path, external: true };
				}

				if (/\.(m?js|cjs|json|node)$/.test(args.path)) {
					return { path: args.path, external: true };
				}

				if (packageHasExportsField(matchedPkg, args.resolveDir)) {
					return { path: args.path, external: true };
				}

				try {
					const resolvedAbsPath = nodeRequire.resolve(args.path, {
						paths: [args.resolveDir],
					});
					const marker = `node_modules${path.sep}`;
					const idx = resolvedAbsPath.lastIndexOf(marker);
					if (idx === -1) return { path: args.path, external: true };
					const correctedSpecifier = resolvedAbsPath
						.slice(idx + marker.length)
						.split(path.sep)
						.join("/");
					return { path: correctedSpecifier, external: true };
				} catch {
					return { path: args.path, external: true };
				}
			});
		},
	};
}

const nodeVersion = (await readFile(".node-version", "utf-8")).trim();
const nodeMajor = nodeVersion.split(".")[0];

async function build() {
	await rm("./dist", { recursive: true, force: true });

	await esbuild.build({
		entryPoints: [
			"./app/server.ts",
			"./app/init.workers.ts",
			"./app/migrate.ts",
		],
		outdir: "./dist",
		bundle: true,
		minify: true,
		sourcemap: true,
		platform: "node",
		target: `node${nodeMajor}`,
		splitting: false,
		format: "esm",
		external: externals,
		plugins: [
			{
				name: "resolve-aliases",
				setup(build) {
					build.onResolve({ filter: /^@\/app\// }, (args) => ({
						path: resolveAlias("./app", args.path, "@/app/"),
					}));
					build.onResolve({ filter: /^@\// }, (args) => ({
						path: resolveAlias("./src", args.path, "@/"),
					}));
				},
			},
			fixExternalDirectoryImports(externals),
		],
	});

	await mkdir("./dist/emails", { recursive: true });
	await cp("./src/emails", "./dist/emails", { recursive: true });
	await mkdir("./dist/migrations", { recursive: true });
	await cp("./src/db/migrations", "./dist/migrations", { recursive: true });
	/* @info - Certificate + receipt Handlebars templates — the generators
	 * resolve from dist/templates first (bundled), then src/templates. */
	await mkdir("./dist/templates", { recursive: true });
	await cp("./src/templates", "./dist/templates", { recursive: true });

	const shim =
		`import{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);\n`;
	for (const file of [
		"./dist/server.js",
		"./dist/init.workers.js",
		"./dist/migrate.js",
	]) {
		const content = await readFile(file, "utf-8");
		if (!content.startsWith(shim)) {
			await writeFile(file, shim + content);
		}
	}

	console.log("Build complete.");
}

build().catch((error) => {
	console.error("Build failed:", error);
	process.exit(1);
});
