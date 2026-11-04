import { describe, expect, test, vi } from "vitest";
import { DEFAULT_TOOL_NAMES, defaultToolNamesFor, SettingsManager } from "../src/core/settings-manager.ts";
import type * as PiBolt from "../src/pi-bolt.ts";

// A Pi-Bolt build (scripts/build-pi.sh defines PIBOLT_BUILD); the tests run as Pi otherwise. (vi.mock runs before the imports.)
vi.mock("../src/pi-bolt.ts", async (importOriginal) => ({
	...(await importOriginal<typeof PiBolt>()),
	PIBOLT: { version: "0.9.0", variant: "arm64", jit: false },
}));

describe("Pi-Bolt's default tools", () => {
	test("grep and find are not on by default, wait is", () => {
		expect(DEFAULT_TOOL_NAMES).toEqual(["read", "bash", "edit", "write", "wait"]);
		expect(defaultToolNamesFor(["/home/me/.pi/agent/extensions/word-count.ts"])).toEqual(DEFAULT_TOOL_NAMES);
	});

	test.each([
		"/home/me/.pi/agent/npm/node_modules/opensec-pi-fff/dist-bun/index.js",
		"/home/me/.pi/agent/npm/node_modules/@ff-labs/pi-fff/dist/index.js",
		"C:\\Users\\me\\.pi\\agent\\npm\\node_modules\\opensec-pi-fff\\dist-bun\\index.js",
		"builtin:opensec-pi-fff",
	])("not with FFF loaded (%s), which brings its own", (path) => {
		expect(defaultToolNamesFor([path])).toEqual(["read", "bash", "edit", "write", "wait"]);
	});

	test("a package that only has fff in its name is not FFF", () => {
		expect(defaultToolNamesFor(["/x/node_modules/opensec-pi-fff-extras/index.js"])).toEqual(DEFAULT_TOOL_NAMES);
	});

	// A defaultTools setting of only +name/-name entries changes the default tools, FFF or not.
	test("a setting that only adds or removes changes the defaults these extensions give", () => {
		const fff = defaultToolNamesFor(["builtin:opensec-pi-fff"]);
		expect(SettingsManager.inMemory({ defaultTools: ["+codemode"] }).getDefaultTools(fff)).toEqual([
			"read",
			"bash",
			"edit",
			"write",
			"wait",
			"codemode",
		]);
		expect(SettingsManager.inMemory({ defaultTools: ["-write"] }).getDefaultTools(fff)).toEqual([
			"read",
			"bash",
			"edit",
			"wait",
		]);
		expect(SettingsManager.inMemory({ defaultTools: ["read", "grep"] }).getDefaultTools(fff)).toEqual([
			"read",
			"grep",
		]);
	});
});
