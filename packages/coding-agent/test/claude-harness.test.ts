import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ClaudeHarnessManager,
	CompileCommandsResolver,
	FileStateTracker,
	fuzzyFilterPaths,
	type HarnessDiagnostic,
	RustDiagnosticsEngine,
	sanitizeCompileFlags,
} from "../src/core/harness/index.ts";
import { buildEnvDiffScript, createBashTool } from "../src/core/tools/bash.ts";
import { createEditTool, createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createFindTool } from "../src/core/tools/find.ts";
import { createLsTool } from "../src/core/tools/ls.ts";
import { getFileFrecencyScore, nativeFind, nativeFindDetailed, nativeGrep } from "../src/core/tools/native-search.ts";
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

	it("blocks an edit of an unread file unless every oldText matches it exactly once, and allows it after read", async () => {
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
				edits: [{ oldText: "return 5;", newText: "return 1;" }],
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
		writeFileSync(filePath, "int x = 5;\n", "utf-8");
		const futureTime = new Date(Date.now() + 2000);
		utimesSync(filePath, futureTime, futureTime);

		await expect(
			editTool.execute("edit-stale", {
				path: "stale.cpp",
				edits: [{ oldText: "int x = 1;", newText: "int x = 2;" }],
			}),
		).rejects.toThrow(/File has been modified since it was last read/);
	});

	it("applies an edit of a file seen only through bash when every oldText matches it exactly once", async () => {
		const harness = new ClaudeHarnessManager({ enableDiagnostics: false });
		const editTool = createEditTool(testDir, { harness, enforceReadBeforeEdit: true, enableDiagnostics: false });
		const writeTool = createWriteTool(testDir, { harness, enforceReadBeforeEdit: true, enableDiagnostics: false });
		const filePath = join(testDir, "seen.ts");
		writeFileSync(filePath, "const a = 1;\nconst b = 2;\nconst b2 = 2;\n", "utf-8");

		const edited = await editTool.execute("e-seen", {
			path: "seen.ts",
			edits: [{ oldText: "const a = 1;", newText: "const a = 3;" }],
		});
		expect(getText(edited)).toContain(
			"The file had not been read in this session; every oldText matched it exactly once.",
		);
		expect(readFileSync(filePath, "utf-8")).toBe("const a = 3;\nconst b = 2;\nconst b2 = 2;\n");
		// Now it counts as read: the next edit needs no note.
		expect(harness.stateTracker.hasBeenRead(filePath)).toBe(true);

		// An oldText that is not there exactly once still asks for a read; write still refuses an unread file.
		writeFileSync(join(testDir, "other.ts"), "x = 2;\nx = 2;\n", "utf-8");
		await expect(
			editTool.execute("e-other", { path: "other.ts", edits: [{ oldText: "x = 2;", newText: "y" }] }),
		).rejects.toThrow(/File has not been read yet/);
		await expect(writeTool.execute("w-other", { path: "other.ts", content: "z\n" })).rejects.toThrow(
			/File has not been read yet/,
		);
	});

	it("allows edit and write after a newer modification time with the same content (touch)", async () => {
		const harness = new ClaudeHarnessManager({ enableDiagnostics: false });
		const readTool = createReadTool(testDir, { harness });
		const editTool = createEditTool(testDir, { harness, enforceReadBeforeEdit: true, enableDiagnostics: false });
		const writeTool = createWriteTool(testDir, { harness, enforceReadBeforeEdit: true, enableDiagnostics: false });
		const filePath = join(testDir, "touched.cpp");
		writeFileSync(filePath, "int x = 1;\n", "utf-8");
		await readTool.execute("read-touch", { path: "touched.cpp" });

		utimesSync(filePath, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
		const edited = await editTool.execute("edit-touch", {
			path: "touched.cpp",
			edits: [{ oldText: "int x = 1;", newText: "int x = 2;" }],
		});
		expect(getText(edited)).not.toContain("changed on disk");

		utimesSync(filePath, new Date(Date.now() + 4000), new Date(Date.now() + 4000));
		await writeTool.execute("write-touch", { path: "touched.cpp", content: "int x = 3;\n" });
		expect(readFileSync(filePath, "utf-8")).toBe("int x = 3;\n");

		// A real change still blocks write, which replaces the whole file.
		writeFileSync(filePath, "int x = 4;\n", "utf-8");
		utimesSync(filePath, new Date(Date.now() + 6000), new Date(Date.now() + 6000));
		await expect(writeTool.execute("write-stale", { path: "touched.cpp", content: "int y;\n" })).rejects.toThrow(
			/File has been modified since it was last read/,
		);
	});

	it("applies an edit to a file changed on disk when every oldText still matches exactly once", async () => {
		const harness = new ClaudeHarnessManager({ enableDiagnostics: false });
		const readTool = createReadTool(testDir, { harness });
		const editTool = createEditTool(testDir, { harness, enforceReadBeforeEdit: true, enableDiagnostics: false });
		const filePath = join(testDir, "formatted.cpp");
		writeFileSync(filePath, "int a=1;\nint b = 2;\n", "utf-8");
		await readTool.execute("read-fmt", { path: "formatted.cpp" });

		// A formatter rewrites another line.
		writeFileSync(filePath, "int a = 1;\nint b = 2;\n", "utf-8");
		utimesSync(filePath, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
		const edited = await editTool.execute("edit-fmt", {
			path: "formatted.cpp",
			edits: [{ oldText: "int b = 2;", newText: "int b = 3;" }],
		});
		expect(getText(edited)).toContain("The file had changed on disk since it was last read");
		expect(readFileSync(filePath, "utf-8")).toBe("int a = 1;\nint b = 3;\n");

		// The next edit sees the file as current; an oldText from before the change is refused.
		writeFileSync(filePath, "int a = 1;\nint b = 3;\nint b = 3;\n", "utf-8");
		utimesSync(filePath, new Date(Date.now() + 4000), new Date(Date.now() + 4000));
		await expect(
			editTool.execute("edit-twice", { path: "formatted.cpp", edits: [{ oldText: "int b = 3;", newText: "x" }] }),
		).rejects.toThrow(/File has been modified since it was last read/);
		await expect(
			editTool.execute("edit-old", { path: "formatted.cpp", edits: [{ oldText: "int a=1;", newText: "x" }] }),
		).rejects.toThrow(/File has been modified since it was last read/);
	});

	it("gives every edit tool the same guidelines, enforced or not", () => {
		const guidelines = (enforce: boolean) =>
			createEditToolDefinition(testDir, { enforceReadBeforeEdit: enforce }).promptGuidelines ?? [];
		// No rule about reading first: a refusal says so when it happens, the prompt need not carry it every request.
		expect(guidelines(true).some((line) => line.includes("not read in this session"))).toBe(false);
		// An extension re-registering the tool must not change the system prompt.
		expect(guidelines(false)).toEqual(guidelines(true));
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
		// Headers that were only read are not overlaid: their tracked text may be stale against the disk
		expect(harness.stateTracker.getUnsavedHeaderOverlays()).toHaveLength(0);

		const newHeader = "__device__ int helper() { return 2; }\n";
		harness.stateTracker.recordFileModifiedByAgent(headerCuh, newHeader, Date.now());
		const overlays = harness.stateTracker.getUnsavedHeaderOverlays();
		expect(overlays).toHaveLength(1);
		expect(overlays[0].filename).toBe(headerCuh);
		expect(overlays[0].content).toBe(newHeader);
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
		expect(slowDiags.diagnostics.some((d) => d.code === "E0502")).toBe(false);
		expect(slowDiags.complete).toBe(false);

		// Wait for the background flycheck (120ms) plus the settle grace after quiescence
		await new Promise((r) => setTimeout(r, 600));

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
			// Turn 1: Model tries to edit vec_add.hip WITHOUT reading it first, with an inexact oldText -> blocked!
			fauxAssistantMessage(
				[
					fauxToolCall(
						"edit",
						{
							path: "vec_add.hip",
							// Not in the file as written: an exact unique match would apply without a read.
							edits: [{ oldText: "int i=0;", newText: "int i = threadIdx.x;" }],
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

	it("lets the process exit after a command ran through the warm bash worker", () => {
		// The worker started for the next command must not hold the event loop (`pi -p` and `--mode json` hung).
		const script = join(testDir, "exit-after-bash.ts");
		const bashModule = join(import.meta.dirname, "..", "src", "core", "tools", "bash.ts");
		writeFileSync(
			script,
			`import { createBashTool } from ${JSON.stringify(bashModule)};\n` +
				`const tool = createBashTool(${JSON.stringify(testDir)});\n` +
				`for (const command of ["echo a | cat", "echo b | cat"]) await tool.execute("x", { command });\n`,
		);
		const result = spawnSync(process.execPath, [script], { timeout: 15_000, encoding: "utf-8" });
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
	});

	it("gives a command run by the warm bash worker an empty stdin, not the rest of its own script", async () => {
		const bashTool = createBashTool(testDir);
		await bashTool.execute("b-stdin-1", { command: "echo first" });
		await new Promise((r) => setTimeout(r, 40));
		// With the script on stdin, `read` would take the next line of the command ("echo after") as its input.
		const res = await bashTool.execute("b-stdin-2", { command: 'read -r line; echo "got:[$line]"\necho after' });
		expect(getText(res).trim().split("\n")).toEqual(["got:[]", "after"]);
	});

	it("removes from the warm bash worker the variables the command's environment leaves out", () => {
		const script = buildEnvDiffScript(
			{ KEEP: "1", CHANGE: "old", GONE: "x" },
			{ KEEP: "1", CHANGE: "new", ADDED: "a'b" },
		);
		expect(script).toContain("export CHANGE='new'\n");
		expect(script).toContain("export ADDED='a'\\''b'\n");
		expect(script).toContain("unset -v GONE\n");
		expect(script).not.toContain("KEEP");
	});

	it("labels find's fuzzy fallback as closest names, not matches, and keeps it short", async () => {
		mkdirSync(join(testDir, "many"), { recursive: true });
		for (let i = 0; i < 40; i++) writeFileSync(join(testDir, "many", `attention_kernel_${i}.hip`), "", "utf-8");
		const detailed = await nativeFindDetailed({
			root: testDir,
			pattern: "attnkernel",
			limit: 1000,
			fuzzyFallback: true,
		});
		expect(detailed.fuzzy).toBe(true);
		expect(detailed.paths.length).toBe(20);
		const exact = await nativeFindDetailed({ root: testDir, pattern: "*.hip", limit: 1000, fuzzyFallback: true });
		expect(exact.fuzzy).toBe(false);

		const findTool = createFindTool(testDir, { native: true });
		const res = await findTool.execute("f-fuzzy", { pattern: "attnkernel" });
		expect(getText(res)).toMatch(/^No files match the pattern\. The closest paths by name/);
		expect(res.details).toMatchObject({ fuzzyFallback: true });
		const found = await findTool.execute("f-exact", { pattern: "attention_kernel_3.hip" });
		expect(getText(found).trim()).toBe("many/attention_kernel_3.hip");
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
				edits: [{ oldText: "__global__ void softmax() {}", newText: "__global__ void softmax_v2() {}" }],
			}),
		).rejects.toThrow(/File has been modified since it was last read/);
	});

	it("supports Codex-style seek_sequence indentation-tolerant fallback matching in edit", async () => {
		const harness = new ClaudeHarnessManager({ enableDiagnostics: false });
		const readTool = createReadTool(testDir, { harness });
		const editTool = createEditTool(testDir, {
			harness,
			enforceReadBeforeEdit: true,
			enableDiagnostics: false,
		});

		const filePath = join(testDir, "indented.ts");
		writeFileSync(
			filePath,
			["export function compute() {", "\tif (ready) {", "\t\treturn 1;", "\t}", "\treturn 0;", "}", ""].join("\n"),
			"utf-8",
		);

		await readTool.execute("r-indent-1", { path: "indented.ts" });

		// Model sends spaces instead of tabs for oldText and newText
		await editTool.execute("e-indent-1", {
			path: "indented.ts",
			edits: [
				{
					oldText: "  if (ready) {\n    return 1;\n  }",
					newText: "  if (ready) {\n\t\treturn 42;\n  }",
				},
			],
		});

		const updated = readFileSync(filePath, "utf-8");
		expect(updated).toBe(
			["export function compute() {", "\tif (ready) {", "\t\treturn 42;", "\t}", "\treturn 0;", "}", ""].join("\n"),
		);
	});

	it("writes lines the edit adds in the file's unit of indentation, not the model's", async () => {
		const harness = new ClaudeHarnessManager({ enableDiagnostics: false });
		const readTool = createReadTool(testDir, { harness });
		const editTool = createEditTool(testDir, { harness, enforceReadBeforeEdit: true, enableDiagnostics: false });
		const edit = async (name: string, file: string, oldText: string, newText: string) => {
			const filePath = join(testDir, name);
			writeFileSync(filePath, file, "utf-8");
			await readTool.execute(`r-${name}`, { path: name });
			await editTool.execute(`e-${name}`, { path: name, edits: [{ oldText, newText }] });
			return readFileSync(filePath, "utf-8");
		};

		// Tabs in the file, four spaces from the model; the new lines are deeper than any oldText line.
		expect(
			await edit(
				"tabs.ts",
				"function f() {\n\tif (a) {\n\t\tg();\n\t}\n}\n",
				"    if (a) {\n        g();\n    }",
				"    if (a) {\n        g();\n        if (b) {\n            h();\n        }\n    }",
			),
		).toBe("function f() {\n\tif (a) {\n\t\tg();\n\t\tif (b) {\n\t\t\th();\n\t\t}\n\t}\n}\n");

		// Two spaces in the file, four from the model, and the same depth of the first line.
		expect(
			await edit(
				"two.py",
				"def f():\n  if a:\n    g()\n",
				"def f():\n    if a:\n        g()",
				"def f():\n    if a:\n        g()\n        for x in y:\n            h(x)",
			),
		).toBe("def f():\n  if a:\n    g()\n    for x in y:\n      h(x)\n");
	});

	it("allows consecutive edits of a CRLF file with a BOM and keeps its bytes intact", async () => {
		const harness = new ClaudeHarnessManager({ enableDiagnostics: false });
		const readTool = createReadTool(testDir, { harness });
		const editTool = createEditTool(testDir, {
			harness,
			enforceReadBeforeEdit: true,
			includePostEditSnippet: true,
			enableDiagnostics: false,
		});

		const filePath = join(testDir, "windows.cpp");
		writeFileSync(filePath, "﻿int a = 1;\r\nint b = 2;\r\n", "utf-8");
		await readTool.execute("r-crlf", { path: "windows.cpp" });

		await editTool.execute("e-crlf-1", {
			path: "windows.cpp",
			edits: [{ oldText: "int a = 1;", newText: "int a = 10;" }],
		});
		const second = await editTool.execute("e-crlf-2", {
			path: "windows.cpp",
			edits: [{ oldText: "int b = 2;", newText: "int b = 20;" }],
		});

		expect(readFileSync(filePath, "utf-8")).toBe("﻿int a = 10;\r\nint b = 20;\r\n");
		// The snippet is rendered from the LF-normalized text
		expect(getText(second)).toContain("     2→int b = 20;\n");
		expect(getText(second)).not.toContain("\r");
	});

	it("allows editing a file larger than the chunked-read threshold after reading part of it", async () => {
		const harness = new ClaudeHarnessManager({ enableDiagnostics: false });
		const readTool = createReadTool(testDir, { harness });
		const editTool = createEditTool(testDir, {
			harness,
			enforceReadBeforeEdit: true,
			enableDiagnostics: false,
		});

		const filePath = join(testDir, "big.txt");
		const lines = Array.from({ length: 40_000 }, (_, i) => `line ${i} ${"x".repeat(32)}`);
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");

		await readTool.execute("r-big", { path: "big.txt", offset: 100, limit: 10 });
		const res = await editTool.execute("e-big", {
			path: "big.txt",
			edits: [{ oldText: `line 39999 ${"x".repeat(32)}`, newText: "last line" }],
		});
		expect(getText(res)).toContain("Successfully replaced 1 block(s) in big.txt.");
		expect(readFileSync(filePath, "utf-8").endsWith("last line\n")).toBe(true);
		expect(harness.stateTracker.getTrackedState(filePath)?.contentComplete).toBe(true);
	});

	it("counts identical diagnostics and reports re-introduced ones again", async () => {
		const harness = new ClaudeHarnessManager({
			customProvider: (absPath, content) =>
				content
					.split("\n")
					.flatMap((line, i): HarnessDiagnostic[] =>
						line.includes("BAD")
							? [{ file: absPath, line: i + 1, column: 1, severity: "error", message: "expected ';'" }]
							: [],
					),
		});
		const readTool = createReadTool(testDir, { harness });
		const editTool = createEditTool(testDir, {
			harness,
			enforceReadBeforeEdit: true,
			enableDiagnostics: true,
		});

		const filePath = join(testDir, "count.cpp");
		writeFileSync(filePath, "int a = 1; // BAD\nint b = 2;\nint c = 3;\n", "utf-8");
		await readTool.execute("r-count", { path: "count.cpp" });
		await new Promise((r) => setTimeout(r, 20));

		// Same message on a second line is a new diagnostic, not the pre-existing one
		const dup = await editTool.execute("e-dup", {
			path: "count.cpp",
			edits: [{ oldText: "int b = 2;", newText: "int b = 2; // BAD" }],
		});
		expect(getText(dup)).toContain("<new-diagnostics>");
		expect(getText(dup)).toContain("Line 2");

		// Fixing it and the original leaves no diagnostics
		const fixed = await editTool.execute("e-fix", {
			path: "count.cpp",
			edits: [
				{ oldText: "int a = 1; // BAD", newText: "int a = 1;" },
				{ oldText: "int b = 2; // BAD", newText: "int b = 2;" },
			],
		});
		expect(getText(fixed)).not.toContain("<new-diagnostics>");

		// Re-introducing it after the fix is reported again
		const again = await editTool.execute("e-again", {
			path: "count.cpp",
			edits: [{ oldText: "int c = 3;", newText: "int c = 3; // BAD" }],
		});
		expect(getText(again)).toContain("<new-diagnostics>");
		expect(getText(again)).toContain("Line 3");
	});

	it("parses headers that borrow flags from a C compile entry as C", () => {
		const cFlags = sanitizeCompileFlags(
			["gcc", "-std=c11", "-Iinclude", "-c", "src/util.c", "-o", "util.o"],
			join(testDir, "src", "util.h"),
			testDir,
		);
		expect(cFlags.slice(0, 2)).toEqual(["-x", "c-header"]);
		expect(cFlags).toContain("-std=c11");
		expect(cFlags).not.toContain("-std=c++20");

		const noStd = sanitizeCompileFlags(["cc", "-c", "src/util.c"], join(testDir, "src", "util.h"), testDir);
		expect(noStd.slice(0, 2)).toEqual(["-x", "c-header"]);
		expect(noStd).not.toContain("-std=c++20");

		const cppFlags = sanitizeCompileFlags(
			["g++", "-std=gnu++17", "-c", "src/util.cpp"],
			join(testDir, "src", "util.h"),
			testDir,
		);
		expect(cppFlags.slice(0, 2)).toEqual(["-x", "c++-header"]);
	});

	// As rust-analyzer 1.99 does: no quiescence after an edit, and no diagnostics but those of the cargo check.
	it("ends a Rust edit's wait when its cargo check ends, and checks in rust-analyzer's own target folder", async () => {
		const mockRaScript = join(testDir, "mock-rust-analyzer-check-end.mjs");
		const initFile = join(testDir, "ra-init.json");
		writeFileSync(
			mockRaScript,
			`
			import { writeFileSync } from "node:fs";
			let buf = Buffer.alloc(0);
			function send(msg) {
				const body = Buffer.from(JSON.stringify(msg), "utf-8");
				process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n", "ascii"), body]));
			}
			const progress = (kind) => send({ jsonrpc: "2.0", method: "$/progress", params: { token: "rust-analyzer/flycheck/0", value: { kind } } });
			process.stdin.on("data", (chunk) => {
				buf = Buffer.concat([buf, chunk]);
				while (true) {
					const end = buf.indexOf("\\r\\n\\r\\n");
					if (end === -1) break;
					const len = Number.parseInt(/Content-Length:\\s*(\\d+)/i.exec(buf.subarray(0, end).toString("ascii"))[1], 10);
					if (buf.length < end + 4 + len) break;
					const msg = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString("utf-8"));
					buf = buf.subarray(end + 4 + len);
					if (msg.method === "initialize") {
						writeFileSync(${JSON.stringify(initFile)}, JSON.stringify(msg.params.initializationOptions));
						send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
					} else if (msg.method === "textDocument/didSave") {
						setTimeout(() => progress("begin"), 20);
						setTimeout(() => progress("end"), 60);
					}
				}
			});
			`,
			"utf-8",
		);
		process.env.RUST_ANALYZER_PATH = mockRaScript;
		const tracker = new FileStateTracker();
		const engine = new RustDiagnosticsEngine(tracker);
		try {
			const rsFile = join(testDir, "lib.rs");
			writeFileSync(rsFile, "pub fn a() {}\n", "utf-8");
			tracker.recordFileRead(rsFile, "pub fn a() {}\n", Date.now());
			await engine.warmupFile(rsFile, "pub fn a() {}\n", testDir);
			const start = performance.now();
			const result = await engine.checkEditedFile(rsFile, "pub fn b() {}\n", testDir);
			expect(performance.now() - start).toBeLessThan(300);
			expect(result.diagnostics).toEqual([]);
			expect(JSON.parse(readFileSync(initFile, "utf-8")).cargo.targetDir).toBe(true);
		} finally {
			engine.dispose();
		}
	});

	it("reports cargo flycheck diagnostics that settle after a fast in-budget result, despite stderr noise", async () => {
		const mockRaScript = join(testDir, "mock-rust-analyzer-flycheck.mjs");
		writeFileSync(
			mockRaScript,
			`
			let buf = Buffer.alloc(0);
			function send(msg) {
				const body = Buffer.from(JSON.stringify(msg), "utf-8");
				process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n", "ascii"), body]));
			}
			// More stderr than a pipe buffer holds: the client must drain it or this process blocks
			process.stderr.write("x".repeat(512 * 1024));
			const pre = { range: { start: { line: 0, character: 0 } }, severity: 2, code: "dead_code", message: "function is never used" };
			const borrow = { range: { start: { line: 2, character: 4 } }, severity: 1, code: "E0502", message: "cannot borrow x as mutable" };
			process.stdin.on("data", (chunk) => {
				buf = Buffer.concat([buf, chunk]);
				while (true) {
					const end = buf.indexOf("\\r\\n\\r\\n");
					if (end === -1) break;
					const len = Number.parseInt(/Content-Length:\\s*(\\d+)/i.exec(buf.subarray(0, end).toString("ascii"))[1], 10);
					if (buf.length < end + 4 + len) break;
					const msg = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString("utf-8"));
					buf = buf.subarray(end + 4 + len);
					if (msg.method === "initialize") {
						send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
					} else if (msg.method === "textDocument/didOpen") {
						send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: msg.params.textDocument.uri, diagnostics: [pre] } });
						send({ jsonrpc: "2.0", method: "experimental/serverStatus", params: { quiescent: true } });
					} else if (msg.method === "textDocument/didSave") {
						const uri = msg.params.textDocument.uri;
						const text = msg.params.text || "";
						// Native diagnostics arrive at once, then quiescence, then a slower cargo check
						send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [pre] } });
						send({ jsonrpc: "2.0", method: "experimental/serverStatus", params: { quiescent: true } });
						setTimeout(() => {
							send({ jsonrpc: "2.0", method: "$/progress", params: { token: "rust-analyzer/flycheck/0", value: { kind: "begin" } } });
						}, 50);
						setTimeout(() => {
							const diagnostics = text.includes("BORROW") ? [pre, borrow] : [pre];
							send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics } });
						}, 500);
						setTimeout(() => {
							send({ jsonrpc: "2.0", method: "$/progress", params: { token: "rust-analyzer/flycheck/0", value: { kind: "end" } } });
						}, 550);
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
		const editTool = createEditTool(testDir, { harness, enforceReadBeforeEdit: true, enableDiagnostics: true });

		const rsFile = join(testDir, "main.rs");
		writeFileSync(rsFile, "fn unused() {}\nfn main() {\n    let x = 1;\n}\n", "utf-8");
		await readTool.execute("r-rs", { path: "main.rs" });
		// Let the warmup's own flycheck settle so it is part of the baseline
		await new Promise((r) => setTimeout(r, 1000));

		const edit = await editTool.execute("e-rs", {
			path: "main.rs",
			edits: [{ oldText: "    let x = 1;", newText: "    let x = 1; BORROW;" }],
		});
		// The pre-existing dead_code warning is not reported as new
		expect(getText(edit)).not.toContain("<new-diagnostics>");

		await new Promise((r) => setTimeout(r, 1000));
		const late = getText(await readTool.execute("r-rs-2", { path: "main.rs" }));
		expect(late).toContain("E0502");
		expect(late).not.toContain("dead_code");
	});
});
