import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const sourceFile = path.join(scriptDir, "src", "fff-bridge.c");
const platform = process.platform;
const arch = process.arch;
const outputDir = path.join(scriptDir, "prebuilds", `${platform}-${arch}`);
const outputFile = path.join(outputDir, "fff-bridge.node");

mkdirSync(outputDir, { recursive: true });

function hasCommand(cmd) {
	const res = spawnSync(cmd, ["--version"], { stdio: "ignore" });
	return !res.error || res.error.code !== "ENOENT";
}

function build() {
	if (platform === "win32") {
		for (const compiler of ["clang", "gcc", "x86_64-w64-mingw32-gcc"]) {
			if (hasCommand(compiler)) {
				const res = spawnSync(compiler, ["-shared", "-O3", "-march=native", sourceFile, "-o", outputFile], {
					stdio: "inherit",
				});
				if (res.status === 0) return true;
			}
		}
		if (hasCommand("cl")) {
			const res = spawnSync("cl", ["/LD", "/O2", sourceFile, `/Fe:${outputFile}`], { stdio: "inherit" });
			if (res.status === 0) return true;
		}
		return false;
	}

	const compilers = platform === "darwin" ? ["clang", "cc"] : ["clang", "gcc", "cc"];
	const simdFlag = arch === "x64" ? "-mavx2" : "-O3";
	for (const compiler of compilers) {
		if (!hasCommand(compiler)) continue;
		const args =
			platform === "darwin"
				? ["-dynamiclib", "-undefined", "dynamic_lookup", "-O3", simdFlag, "-fPIC", sourceFile, "-o", outputFile]
				: ["-shared", "-O3", simdFlag, "-fPIC", sourceFile, "-o", outputFile];
		const res = spawnSync(compiler, args, { stdio: "inherit" });
		if (res.status === 0) return true;
	}
	return false;
}

if (build() && existsSync(outputFile)) {
	console.log(`Built ${outputFile}`);
} else {
	console.warn(`Could not build fff-bridge.node on ${platform}-${arch} (no C compiler found in PATH).`);
	process.exitCode = 0;
}
