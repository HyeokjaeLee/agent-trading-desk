import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/cli.ts", "src/index.ts"],
	format: ["esm"],
	target: "node22",
	platform: "node",
	dts: true,
	sourcemap: true,
	clean: true,
	banner: { js: "#!/usr/bin/env node" },
	// Keep all dependencies external so CJS deps (yaml, proper-lockfile, etc.)
	// resolve normally from node_modules at runtime. Run with bun or node.
});
