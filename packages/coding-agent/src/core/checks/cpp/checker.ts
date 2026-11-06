import { readFileSync } from "node:fs";
import type { Checker } from "../checkers.ts";
import { isCppOrHipFile } from "./files.ts";
import type { LibclangEngine } from "./libclang.ts";

/**
 * C, C++ and HIP through libclang as a background check (see background-checks.ts), so that an edit does not wait for
 * the reparse: a tenth of a second on a warm translation unit, seconds on a large one. The engine knows the files read
 * and changed: a header is parsed in a source that includes it, with the other headers the agent changed. Undefined
 * when the libclang bridge is not there.
 */
export function cppChecker(engine: LibclangEngine, workspaceCwd: string): Checker | undefined {
	if (!engine.available()) return undefined;
	const checker: Checker = {
		name: "cpp",
		matches: (path) => isCppOrHipFile(path),
		unit: (path) => ({ key: `cpp:${path}`, checker, cwd: workspaceCwd, file: path }),
		run: (unit) => engine.check(unit.file!, readFileSync(unit.file!, "utf8"), unit.cwd),
	};
	return checker;
}
