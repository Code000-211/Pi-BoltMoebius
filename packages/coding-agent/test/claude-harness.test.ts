import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ClaudeHarnessManager,
	CompileCommandsResolver,
	fuzzyFilterPaths,
	type HarnessDiagnostic,
	sanitizeCompileFlags,
} from "../src/core/harness/index.ts";
import { createBashTool } from "../src/core/tools/bash.ts";
import { createEditTool } from "../src/core/tools/edit.ts";
import { createLsTool } from "../src/core/tools/ls.ts";
import { getFileFrecencyScore, nativeFind, nativeGrep } from "../src/core/tools/native-search.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { createWriteTool } from "../src/core/tools/write.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function getText(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("\n") ?? ""
	);
}

describe("Claude Harness (Read-Before-Edit, Pre-Warming, Diagnostics Diffing & HIP Flags)", () => {
	let testDir: string;
	const harnesses: Harness[] = [];
	const claudeManagers: ClaudeHarnessManager[] = [];

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-claude-harness-"));
	});

	afterEach(async () => {
		while (claudeManagers.length > 0) claudeManagers.pop()?.dispose();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		delete process.env.RUST_ANALYZER_PATH;
		delete process.env.CLANGD_PATH;
		await new Promise((r) => setTimeout(r, 25));
		rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	it("blocks editing an existing file before it has been read, and allows it after read", async () => {
		const harness = new ClaudeHarnessManager({ enableDiagnostics: false });
		const readTool = createReadTool(testDir, { harness });
		const editTool = createEditTool(testDir, {
			harness,
			enforceReadBeforeEdit: true,
			includePostEditSnippet: true,
			enableDiagnostics: false,
		});

		const filePath = join(testDir, "kernel.hip");
		writeFileSync(filePath, "int main() {\n\treturn 0;\n}\n", "utf-8");

		await expect(
			editTool.execute("call-edit-1", {
				path: "kernel.hip",
				edits: [{ oldText: "return 0;", newText: "return 1;" }],
			}),
		).rejects.toThrow(/File has not been read yet\. Read it first before writing to it\./);

		await readTool.execute("call-read-1", { path: "kernel.hip" });

		const editRes = await editTool.execute("call-edit-2", {
			path: "kernel.hip",
			edits: [{ oldText: "return 0;", newText: "return 42;" }],
		});

		const text = getText(editRes);
		expect(text).toContain("Successfully replaced 1 block(s) in kernel.hip.");
		expect(text).toContain("Here is a snippet of the edited file around line 2:");
		expect(text).toContain("     2→\treturn 42;");

		// Consecutive edit by the agent without an intermediate read must also succeed
		const editRes2 = await editTool.execute("call-edit-3", {
			path: "kernel.hip",
			edits: [{ oldText: "return 42;", newText: "return 99;" }],
		});
		expect(getText(editRes2)).toContain("     2→\treturn 99;");
	});

	it("blocks editing if the file was modified externally since the last read (mtime staleness)", async () => {
		const harness = new ClaudeHarnessManager({ enableDiagnostics: false });
		const readTool = createReadTool(testDir, { harness });
		const editTool = createEditTool(testDir, {
			harness,
			enforceReadBeforeEdit: true,
			enableDiagnostics: false,
		});

		const filePath = join(testDir, "stale.cpp");
		writeFileSync(filePath, "int x = 1;\n", "utf-8");

		await readTool.execute("read-1", { path: "stale.cpp" });

		// Simulate external modification advancing mtime by 2 seconds
		const futureTime = new Date(Date.now() + 2000);
		utimesSync(filePath, futureTime, futureTime);

		await expect(
			editTool.execute("edit-stale", {
				path: "stale.cpp",
				edits: [{ oldText: "int x = 1;", newText: "int x = 2;" }],
			}),
		).rejects.toThrow(/File has been modified since it was last read/);
	});

	it("allows write on a brand-new file without prior read, but blocks overwriting an unread existing file", async () => {
		const harness = new ClaudeHarnessManager({ enableDiagnostics: false });
		const readTool = createReadTool(testDir, { harness });
		const writeTool = createWriteTool(testDir, {
			harness,
			enforceReadBeforeEdit: true,
			enableDiagnostics: false,
		});

		// Brand-new file succeeds without prior read
		const newRes = await writeTool.execute("write-new", {
			path: "new_file.rs",
			content: "pub fn hello() {}\n",
		});
		expect(getText(newRes)).toContain("Successfully wrote to new_file.rs");

		// Existing unread file is blocked
		const unreadExisting = join(testDir, "existing.rs");
		writeFileSync(unreadExisting, "fn old() {}\n", "utf-8");

		await expect(
			writeTool.execute("write-unread", {
				path: "existing.rs",
				content: "fn overwritten() {}\n",
			}),
		).rejects.toThrow(/File has not been read yet/);

		// After reading, overwrite succeeds
		await readTool.execute("read-existing", { path: "existing.rs" });
		const overwriteRes = await writeTool.execute("write-after-read", {
			path: "existing.rs",
			content: "fn overwritten() {}\n",
		});
		expect(getText(overwriteRes)).toContain("Successfully wrote to existing.rs");
	});

	it("pre-warms baseline diagnostics on read and only emits NEW diagnostics in <new-diagnostics> on edit", async () => {
		const harness = new ClaudeHarnessManager({
			customProvider: async (absPath, content) => {
				const diags: HarnessDiagnostic[] = [];
				const lines = content.split("\n");
				for (let i = 0; i < lines.length; i++) {
					if (lines[i].includes("UNUSED_VAR")) {
						diags.push({
							file: absPath,
							line: i + 1,
							column: 6,
							severity: "warning",
							code: "-Wunused-variable",
							message: "unused variable 'UNUSED_VAR'",
						});
					}
					if (lines[i].includes("hipThreadIdx_typo")) {
						diags.push({
							file: absPath,
							line: i + 1,
							column: 12,
							severity: "error",
							code: "undeclared_var_use",
							message: "use of undeclared identifier 'hipThreadIdx_typo'",
						});
					}
				}
				return diags;
			},
		});

		const readTool = createReadTool(testDir, { harness });
		const editTool = createEditTool(testDir, {
			harness,
			enforceReadBeforeEdit: true,
			includePostEditSnippet: true,
			enableDiagnostics: true,
		});

		const filePath = join(testDir, "gemm.hip");
		writeFileSync(
			filePath,
			[
				"#include <hip/hip_runtime.h>",
				"__global__ void gemm() {",
				"    int UNUSED_VAR = 0;",
				"    int tid = 0;",
				"}",
				"",
			].join("\n"),
			"utf-8",
		);

		await readTool.execute("read-hip", { path: "gemm.hip" });
		// Wait a tick for background warmup to record baseline
		await new Promise((r) => setTimeout(r, 10));

		// Edit 1: introduce a typo error while keeping the pre-existing UNUSED_VAR warning
		const edit1 = await editTool.execute("edit-hip-1", {
			path: "gemm.hip",
			edits: [{ oldText: "    int tid = 0;", newText: "    int tid = hipThreadIdx_typo;" }],
		});
		const text1 = getText(edit1);

		// Should report ONLY the newly introduced error, NOT the pre-existing UNUSED_VAR warning!
		expect(text1).toContain("<new-diagnostics>");
		expect(text1).toContain("use of undeclared identifier 'hipThreadIdx_typo'");
		expect(text1).not.toContain("unused variable 'UNUSED_VAR'");

		// Edit 2: fix the typo error -> no <new-diagnostics> block should be emitted
		const edit2 = await editTool.execute("edit-hip-2", {
			path: "gemm.hip",
			edits: [{ oldText: "    int tid = hipThreadIdx_typo;", newText: "    int tid = threadIdx.x;" }],
		});
		const text2 = getText(edit2);
		expect(text2).not.toContain("<new-diagnostics>");
	});

	it("sanitizes HIP compile_commands.json flags (single offload-arch, strips GCC flags, infers header flags)", () => {
		const rawArgs = [
			"/opt/rocm/bin/hipcc",
			"-D__HIP_PLATFORM_AMD__",
			"-I/opt/rocm/include",
			"--offload-arch=gfx90a",
			"--offload-arch=gfx942",
			"--offload-arch=gfx1100",
			"-fno-canonical-system-headers",
			"-O3",
			"-c",
			"src/attention.hip",
			"-o",
			"build/attention.hip.o",
		];

		const targetHip = join(testDir, "src", "attention.hip");
		const sanitized = sanitizeCompileFlags(rawArgs, targetHip, testDir);

		// Keeps only the first --offload-arch for single-pass speed
		const offloadFlags = sanitized.filter((a) => a.startsWith("--offload-arch="));
		expect(offloadFlags).toEqual(["--offload-arch=gfx90a"]);
		expect(sanitized).not.toContain("-fno-canonical-system-headers");
		expect(sanitized).not.toContain("-c");
		expect(sanitized).not.toContain("build/attention.hip.o");
		expect(sanitized).toContain("-x");
		expect(sanitized).toContain("hip");

		// Write compile_commands.json and test header inference for a .cuh file in the same directory
		const compileDbPath = join(testDir, "compile_commands.json");
		writeFileSync(
			compileDbPath,
			JSON.stringify([
				{
					directory: testDir,
					file: "src/attention.hip",
					arguments: rawArgs,
				},
			]),
			"utf-8",
		);

		const resolver = new CompileCommandsResolver();
		const headerFlags = resolver.getFlagsForFile(join(testDir, "src", "attention_kernels.cuh"), testDir);
		expect(headerFlags).toContain("-D__HIP_PLATFORM_AMD__");
		expect(headerFlags).toContain("--offload-arch=gfx90a");
		expect(headerFlags).toContain("hip-header");
	});

	it("maps included headers back to their host .hip translation unit for in-memory overlay reparsing", () => {
		const harness = new ClaudeHarnessManager({ enableDiagnostics: false });
		const mainHip = join(testDir, "main.hip");
		const headerCuh = join(testDir, "common.cuh");

		harness.onFileRead(mainHip, '#include "common.cuh"\n__global__ void k() {}\n', Date.now(), testDir);
		harness.onFileRead(headerCuh, "__device__ int helper() { return 1; }\n", Date.now(), testDir);

		expect(harness.stateTracker.findHostSourceForHeader(headerCuh)).toBe(mainHip);
		const overlays = harness.stateTracker.getUnsavedHeaderOverlays();
		expect(overlays).toHaveLength(1);
		expect(overlays[0].filename).toBe(headerCuh);
	});

	it("handles 2-tier Rust LSP diagnostics (fast in-memory + late borrow-checker via <system-reminder>)", async () => {
		// Create a mock rust-analyzer JSON-RPC stdio server script
		const mockRaScript = join(testDir, "mock-rust-analyzer.mjs");
		writeFileSync(
			mockRaScript,
			`
			let buf = Buffer.alloc(0);
			function send(msg) {
				const body = Buffer.from(JSON.stringify(msg), "utf-8");
				const header = Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n", "ascii");
				process.stdout.write(Buffer.concat([header, body]));
			}
			process.stdin.on("data", (chunk) => {
				buf = Buffer.concat([buf, chunk]);
				while (true) {
					const end = buf.indexOf("\\r\\n\\r\\n");
					if (end === -1) break;
					const hdr = buf.subarray(0, end).toString("ascii");
					const m = /Content-Length:\\s*(\\d+)/i.exec(hdr);
					const len = Number.parseInt(m[1], 10);
					if (buf.length < end + 4 + len) break;
					const msg = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString("utf-8"));
					buf = buf.subarray(end + 4 + len);

					if (msg.method === "initialize") {
						send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
					} else if (msg.method === "textDocument/didOpen") {
						const uri = msg.params.textDocument.uri;
						send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
						send({ jsonrpc: "2.0", method: "experimental/serverStatus", params: { quiescent: true } });
					} else if (msg.method === "textDocument/didSave") {
						const uri = msg.params.textDocument.uri;
						const text = msg.params.text || "";
						if (text.includes("FAST_TYPE_ERROR")) {
							send({
								jsonrpc: "2.0",
								method: "textDocument/publishDiagnostics",
								params: {
									uri,
									diagnostics: [{
										range: { start: { line: 1, character: 8 } },
										severity: 1,
										code: "E0308",
										message: "mismatched types: expected u32, found &str",
									}],
								},
							});
							send({ jsonrpc: "2.0", method: "experimental/serverStatus", params: { quiescent: true } });
						} else if (text.includes("SLOW_BORROW_ERROR")) {
							// Simulate slow cargo flycheck arriving AFTER the edit wait budget (120ms vs 50ms budget)
							setTimeout(() => {
								send({
									jsonrpc: "2.0",
									method: "textDocument/publishDiagnostics",
									params: {
										uri,
										diagnostics: [{
											range: { start: { line: 2, character: 4 } },
											severity: 1,
											code: "E0502",
											message: "cannot borrow x as mutable because it is also borrowed as immutable",
										}],
									},
								});
								send({ jsonrpc: "2.0", method: "experimental/serverStatus", params: { quiescent: true } });
							}, 120);
						}
					}
				}
			});
			`,
			"utf-8",
		);

		process.env.RUST_ANALYZER_PATH = mockRaScript;
		const harness = new ClaudeHarnessManager({ enableDiagnostics: true });
		claudeManagers.push(harness);
		const readTool = createReadTool(testDir, { harness });
		const editTool = createEditTool(testDir, {
			harness,
			enforceReadBeforeEdit: true,
			enableDiagnostics: true,
		});

		const rsFile = join(testDir, "lib.rs");
		writeFileSync(rsFile, "pub fn compute() {\n    let x = 1;\n}\n", "utf-8");

		// 1. Read file (warms up rust-analyzer)
		await readTool.execute("r1", { path: "lib.rs" });

		// 2. Fast in-memory error arrives immediately within budget
		const fastEdit = await editTool.execute("e1", {
			path: "lib.rs",
			edits: [{ oldText: "    let x = 1;", newText: "    let x = FAST_TYPE_ERROR;" }],
		});
		expect(getText(fastEdit)).toContain("mismatched types: expected u32, found &str");

		// 3. Test slow borrow-checker error arriving after budget (50ms budget, 120ms flycheck)
		const slowDiags = await harness.rustEngine.checkEditedFile(
			rsFile,
			"pub fn compute() {\n    let x = 1;\n    SLOW_BORROW_ERROR;\n}\n",
			testDir,
			50,
		);
		// Immediate return at 50ms did not block waiting for the 120ms cargo check
		expect(slowDiags.some((d) => d.code === "E0502")).toBe(false);

		// Wait for the background flycheck to finish (220ms > 120ms)
		await new Promise((r) => setTimeout(r, 220));

		// Next read tool call automatically delivers the late borrow-checker error in <system-reminder>!
		const nextRead = await readTool.execute("r2", { path: "lib.rs" });
		const nextReadText = getText(nextRead);
		expect(nextReadText).toContain("<system-reminder>");
		expect(nextReadText).toContain("E0502");
		expect(nextReadText).toContain("cannot borrow x as mutable");
		harness.dispose();
		await new Promise((r) => setTimeout(r, 30));
	});

	it("enforces Read-Before-Edit and Post-Edit Snippet end-to-end inside a full AgentSession", async () => {
		const sessionHarness = await createHarness({
			initialActiveToolNames: ["read", "edit", "write"],
		});
		harnesses.push(sessionHarness);

		const hipFile = join(sessionHarness.tempDir, "vec_add.hip");
		writeFileSync(hipFile, "__global__ void vecAdd() {\n    int i = 0;\n}\n", "utf-8");

		sessionHarness.setResponses([
			// Turn 1: Model tries to edit vec_add.hip WITHOUT reading it first -> blocked!
			fauxAssistantMessage(
				[
					fauxToolCall(
						"edit",
						{
							path: "vec_add.hip",
							edits: [{ oldText: "int i = 0;", newText: "int i = threadIdx.x;" }],
						},
						{ id: "call-blind-edit" },
					),
				],
				{ stopReason: "toolUse", timestamp: 1 },
			),
			// Turn 2: Model reads vec_add.hip first
			fauxAssistantMessage([fauxToolCall("read", { path: "vec_add.hip" }, { id: "call-read-first" })], {
				stopReason: "toolUse",
				timestamp: 2,
			}),
			// Turn 3: Model edits vec_add.hip -> succeeds with line-numbered snippet!
			fauxAssistantMessage(
				[
					fauxToolCall(
						"edit",
						{
							path: "vec_add.hip",
							edits: [{ oldText: "int i = 0;", newText: "int i = threadIdx.x;" }],
						},
						{ id: "call-valid-edit" },
					),
				],
				{ stopReason: "toolUse", timestamp: 3 },
			),
			fauxAssistantMessage("Updated vecAdd kernel.", { timestamp: 4 }),
		]);

		await sessionHarness.session.prompt("Update vec_add.hip to use threadIdx.x");

		const toolResults = sessionHarness.session.messages.filter(
			(m): m is ToolResultMessage => m.role === "toolResult",
		);
		expect(toolResults).toHaveLength(3);

		// 1st tool result (blind edit) must be an error blocking the edit
		expect(toolResults[0].isError).toBe(true);
		expect(getText(toolResults[0])).toContain("File has not been read yet. Read it first before writing to it.");

		// 2nd tool result (read) succeeded
		expect(toolResults[1].isError).toBe(false);
		expect(getText(toolResults[1])).toContain("__global__ void vecAdd()");

		// 3rd tool result (edit after read) succeeded and includes the cat -n context snippet
		expect(toolResults[2].isError).toBe(false);
		expect(getText(toolResults[2])).toContain("Successfully replaced 1 block(s) in vec_add.hip.");
		expect(getText(toolResults[2])).toContain("2→    int i = threadIdx.x;");
	});

	it("runs C++/HIP diagnostics end-to-end via CppHipDiagnosticsEngine (didOpen on read, didChange on edit)", async () => {
		const mockClangdScript = join(testDir, "mock-clangd.mjs");
		writeFileSync(
			mockClangdScript,
			`
			let buf = Buffer.alloc(0);
			function send(msg) {
				const body = Buffer.from(JSON.stringify(msg), "utf-8");
				const header = Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n", "ascii");
				process.stdout.write(Buffer.concat([header, body]));
			}
			process.stdin.on("data", (chunk) => {
				buf = Buffer.concat([buf, chunk]);
				while (true) {
					const end = buf.indexOf("\\r\\n\\r\\n");
					if (end === -1) break;
					const hdr = buf.subarray(0, end).toString("ascii");
					const m = /Content-Length:\\s*(\\d+)/i.exec(hdr);
					const len = Number.parseInt(m[1], 10);
					if (buf.length < end + 4 + len) break;
					const msg = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString("utf-8"));
					buf = buf.subarray(end + 4 + len);

					if (msg.method === "initialize") {
						send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
					} else if (msg.method === "textDocument/didOpen") {
						const uri = msg.params.textDocument.uri;
						send({
							jsonrpc: "2.0",
							method: "textDocument/publishDiagnostics",
							params: {
								uri,
								diagnostics: [{
									range: { start: { line: 0, character: 0 } },
									severity: 2,
									code: "-Wunused-parameter",
									message: "unused parameter 'n'",
								}],
							},
						});
					} else if (msg.method === "textDocument/didChange") {
						const uri = msg.params.textDocument.uri;
						const text = msg.params.contentChanges[0]?.text || "";
						const diags = [{
							range: { start: { line: 0, character: 0 } },
							severity: 2,
							code: "-Wunused-parameter",
							message: "unused parameter 'n'",
						}];
						if (text.includes("__syncthreads_typo()")) {
							diags.push({
								range: { start: { line: 2, character: 4 } },
								severity: 1,
								code: "undeclared_identifier",
								message: "use of undeclared identifier '__syncthreads_typo'; did you mean '__syncthreads'?",
							});
						}
						send({
							jsonrpc: "2.0",
							method: "textDocument/publishDiagnostics",
							params: { uri, diagnostics: diags },
						});
					}
				}
			});
			`,
			"utf-8",
		);

		process.env.CLANGD_PATH = mockClangdScript;
		const harness = new ClaudeHarnessManager({ enableDiagnostics: true });
		claudeManagers.push(harness);
		const readTool = createReadTool(testDir, { harness });
		const editTool = createEditTool(testDir, {
			harness,
			enforceReadBeforeEdit: true,
			includePostEditSnippet: true,
			enableDiagnostics: true,
		});

		const hipPath = join(testDir, "reduce.hip");
		writeFileSync(hipPath, "__global__ void reduce(int n) {\n    int x = 0;\n}\n", "utf-8");

		// 1. Read triggers didOpen warmup and records baseline warning (-Wunused-parameter)
		await readTool.execute("r-hip", { path: "reduce.hip" });

		// 2. Edit introduces a HIP intrinsic typo -> waits for warmup, runs didChange, diffs baseline
		const editRes = await editTool.execute("e-hip", {
			path: "reduce.hip",
			edits: [{ oldText: "    int x = 0;", newText: "    __syncthreads_typo();" }],
		});
		const editText = getText(editRes);

		expect(editText).toContain("<new-diagnostics>");
		expect(editText).toContain("use of undeclared identifier '__syncthreads_typo'");
		expect(editText).not.toContain("unused parameter 'n'");

		harness.dispose();
		await new Promise((r) => setTimeout(r, 30));
	});

	it("supports fff-style boundary-aware fuzzy path ranking, in-memory tree/content caching, and frecency tracking", async () => {
		const paths = [
			"third_party/legacy_attention_kernel_test_helper.cpp",
			"src/kernels/attention_kernel.hip",
			"docs/attention_kernel_notes.md",
			"src/utils/math.h",
		];

		// Fuzzy search ranks exact basename / boundary match (`src/kernels/attention_kernel.hip`) #1
		const ranked = fuzzyFilterPaths(paths, "attnkernel", 3);
		expect(ranked[0]).toBe("src/kernels/attention_kernel.hip");

		mkdirSync(join(testDir, "src", "kernels"), { recursive: true });
		const hipKernel = join(testDir, "src", "kernels", "flash_attn_v2.hip");
		writeFileSync(hipKernel, "__global__ void flash_attn_v2() {}\n", "utf-8");

		// Fuzzy fallback in nativeFind locates the file even when the query is approximate
		const foundFuzzy = await nativeFind({
			root: testDir,
			pattern: "flashattnv2",
			limit: 10,
			fuzzyFallback: true,
		});
		expect(foundFuzzy).toEqual(["src/kernels/flash_attn_v2.hip"]);

		// Reading & editing through ClaudeHarnessManager boosts frecency and updates in-memory grep buffer cache
		const harness = new ClaudeHarnessManager({ enableDiagnostics: false });
		const readTool = createReadTool(testDir, { harness });
		const editTool = createEditTool(testDir, { harness, enforceReadBeforeEdit: true, enableDiagnostics: false });

		await readTool.execute("r-frec", { path: "src/kernels/flash_attn_v2.hip" });
		expect(getFileFrecencyScore(hipKernel)).toBeGreaterThanOrEqual(10);

		await editTool.execute("e-frec", {
			path: "src/kernels/flash_attn_v2.hip",
			edits: [{ oldText: "flash_attn_v2()", newText: "flash_attn_v2_optimized()" }],
		});
		expect(getFileFrecencyScore(hipKernel)).toBeGreaterThanOrEqual(20);

		const grepRes = await nativeGrep({
			root: testDir,
			isDirectory: true,
			pattern: "flash_attn_v2_optimized",
			literal: true,
			limit: 10,
			keepChars: 200,
		});
		expect(grepRes.matches).toHaveLength(1);
		expect(grepRes.matches[0].lineText).toContain("flash_attn_v2_optimized");
	});

	it("executes bash commands via warm standby worker and direct binary fast-path with zero-copy OutputAccumulator", async () => {
		const bashTool = createBashTool(testDir);
		const lsTool = createLsTool(testDir);
		writeFileSync(join(testDir, "fast.txt"), "hello\n", "utf-8");

		// 1. First bash command triggers warm standby replenishment
		const res1 = await bashTool.execute("b-warm-1", { command: "echo warm_first" });
		expect(getText(res1).trim()).toBe("warm_first");

		// Give setImmediate a tick to spawn the warm standby process
		await new Promise((r) => setTimeout(r, 40));

		// 2. Second bash command uses the pre-spawned warm bash worker (supports builtins + pipes)
		const t0 = performance.now();
		const res2 = await bashTool.execute("b-warm-2", { command: "echo warm_second | tr 'a-z' 'A-Z'" });
		const warmMs = performance.now() - t0;
		expect(getText(res2).trim()).toBe("WARM_SECOND");
		expect(warmMs).toBeLessThan(500);

		// 3. Direct binary fast-path (no shell metacharacters, e.g. git --version)
		const res3 = await bashTool.execute("b-direct-git", { command: "git --version" });
		expect(getText(res3)).toContain("git version");

		// 4. Single-syscall ls
		const lsRes = await lsTool.execute("ls-fast", {});
		expect(getText(lsRes)).toContain("fast.txt");
	});

	it("discovers nested CLAUDE.md and AGENTS.md files on read once per session and checks content staleness", async () => {
		const harness = new ClaudeHarnessManager({ enableDiagnostics: false });
		const readTool = createReadTool(testDir, { harness });
		const editTool = createEditTool(testDir, {
			harness,
			enforceReadBeforeEdit: true,
			enableDiagnostics: false,
		});

		// Root CLAUDE.md (already loaded at startup -> must NOT be re-attached on read)
		writeFileSync(join(testDir, "CLAUDE.md"), "# Root rules\n", "utf-8");

		// Nested directory with its own CLAUDE.md and source files
		const subDir = join(testDir, "packages", "kernels");
		mkdirSync(subDir, { recursive: true });
		const nestedClaudeMd = join(subDir, "CLAUDE.md");
		writeFileSync(nestedClaudeMd, "Always use __launch_bounds__(256) in this package.\n", "utf-8");

		const fileA = join(subDir, "matmul.hip");
		const fileB = join(subDir, "softmax.hip");
		writeFileSync(fileA, "__global__ void matmul() {}\n", "utf-8");
		writeFileSync(fileB, "__global__ void softmax() {}\n", "utf-8");

		// 1st read in packages/kernels attaches nested CLAUDE.md in <system-reminder>, but NOT root CLAUDE.md
		const readA = await readTool.execute("r-nested-1", { path: "packages/kernels/matmul.hip" });
		const textA = getText(readA);
		expect(textA).toContain("<system-reminder>");
		expect(textA).toContain(`Contents of ${nestedClaudeMd}:`);
		expect(textA).toContain("Always use __launch_bounds__(256) in this package.");
		expect(textA).not.toContain("# Root rules");

		// 2nd read in the same subdirectory must NOT re-attach the already-delivered nested CLAUDE.md
		const readB = await readTool.execute("r-nested-2", { path: "packages/kernels/softmax.hip" });
		const textB = getText(readB);
		expect(textB).not.toContain("Always use __launch_bounds__(256) in this package.");

		// Content-equality staleness guard: modify fileB externally while preserving exact mtime
		const preservedDate = new Date();
		utimesSync(fileB, preservedDate, preservedDate);
		await readTool.execute("r-nested-3", { path: "packages/kernels/softmax.hip" });
		writeFileSync(fileB, "__global__ void softmax() { /* external sub-ms edit */ }\n", "utf-8");
		utimesSync(fileB, preservedDate, preservedDate);

		await expect(
			editTool.execute("e-content-stale", {
				path: "packages/kernels/softmax.hip",
				edits: [{ oldText: "__global__ void softmax()", newText: "__global__ void softmax_v2()" }],
			}),
		).rejects.toThrow(/File has been modified since it was last read/);
	});
});
