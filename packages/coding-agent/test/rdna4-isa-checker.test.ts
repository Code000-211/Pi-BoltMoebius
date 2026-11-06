import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHECKERS, onPath, radisaDiagnostics } from "../src/core/checks/checkers.ts";

const rdna4 = CHECKERS.find((c) => c.name === "rdna4-isa")!;
/** A checkout of the suite, for the test that runs radisa itself. */
const suite = process.env.PI_RADISA;

describe("rdna4-isa checker", () => {
	let dir: string;
	const saved = { ...process.env };

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-rdna4-"));
		delete process.env.PI_RADISA;
		delete process.env.HIP_OFFLOAD_ARCH;
		delete process.env.HCC_AMDGPU_TARGET;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		process.env = { ...saved };
	});

	/** A project with the suite under tools/ and a compile_commands.json building `file` for `arch`. */
	function project(file: string, arch: string): string {
		mkdirSync(join(dir, "tools", "rdna4-isa-suite", "radisa"), { recursive: true });
		writeFileSync(join(dir, "tools", "rdna4-isa-suite", "radisa", "__main__.py"), "");
		mkdirSync(join(dir, "build"));
		writeFileSync(
			join(dir, "build", "compile_commands.json"),
			JSON.stringify([{ directory: dir, file, command: `clang++ -x hip --offload-arch=${arch} -c ${file}` }]),
		);
		const path = join(dir, file);
		writeFileSync(path, "");
		return path;
	}

	it("takes HIP units built for gfx12 and leaves other targets to the C/C++ checks", () => {
		if (!onPath("python3")) return;
		expect(rdna4.unit(project("k.hip", "gfx1201"))?.key).toBe(`rdna4-isa:${join(dir, "k.hip")}`);
		rmSync(join(dir, "build"), { recursive: true });
		expect(rdna4.unit(project("halo.hip", "gfx1151"))).toBeUndefined();
	});

	it("needs the suite", () => {
		const path = join(dir, "k.hip");
		writeFileSync(path, "");
		expect(rdna4.unit(path)).toBeUndefined();
		process.env.PI_RADISA = join(dir, "missing");
		expect(rdna4.unit(path)).toBeUndefined();
	});

	it("takes .s files only when they are AMDGPU assembly", () => {
		const amd = join(dir, "k.s");
		writeFileSync(amd, "global_load_b32 v1, v[2:3], off\ns_endpgm\n");
		const x86 = join(dir, "x.s");
		writeFileSync(x86, "movq %rsp, %rbp\nret\n");
		expect(rdna4.matches(amd)).toBe(true);
		expect(rdna4.matches(x86)).toBe(false);
	});

	it("maps errors to errors and warnings to lint, without volatile pcs or rules the agent cannot fix", () => {
		const file = "/p/k.hip";
		const diagnostics = radisaDiagnostics(
			{
				findings: [
					{ rule: "COMPILE", severity: "error", message: "device compile failed" },
					{ rule: "HIP_INLINE_ASM_MEMORY", severity: "review", message: "asm load", loc: { file, line: 14 } },
					{ rule: "HIP_NO_LAUNCH_BOUNDS", severity: "info", message: "no bounds", loc: { file, line: 3 } },
				],
				kernels: [
					{
						name: "racy",
						findings: [
							{
								rule: "MISSING_WAIT",
								severity: "error",
								message: "v_add_f32_e32 reads v1 while ds_load_b32 (pc 0x124) may still be outstanding",
								loc: { file, line: 15, column: 12 },
								instruction: "v_add_f32_e32 v1, 1.0, v1",
							},
							{ rule: "VOPD_ANTIDEP", severity: "review", message: "X writes v3", loc: { file, line: 9 } },
							{ rule: "REGISTER_SPILL", severity: "review", message: "2 VGPR spills", pc: null },
						],
					},
				],
			},
			file,
		);
		expect(diagnostics).toEqual([
			{ file, line: 14, column: 1, severity: "warning", message: "asm load", code: "HIP_INLINE_ASM_MEMORY" },
			{
				file,
				line: 15,
				column: 12,
				severity: "error",
				message: "v_add_f32_e32 reads v1 while ds_load_b32 may still be outstanding [v_add_f32_e32 v1, 1.0, v1]",
				code: "MISSING_WAIT",
			},
			{
				file,
				line: 1,
				column: 1,
				severity: "warning",
				message: "in kernel racy: 2 VGPR spills",
				code: "REGISTER_SPILL",
			},
		]);
	});

	// Runs radisa itself when PI_RADISA names a checkout of the suite and llvm-mc is installed.
	it.runIf(suite && onPath("python3") && onPath("llvm-mc"))(
		"reports a load whose result is used before its wait",
		async () => {
			process.env.PI_RADISA = suite;
			const path = join(dir, "k.s");
			writeFileSync(path, "global_load_b32 v1, v[2:3], off\nv_add_f32 v4, v1, v1\ns_endpgm\n");
			const unit = rdna4.unit(path)!;
			const found = await rdna4.run(unit, new AbortController().signal);
			expect(found).toHaveLength(1);
			expect(found[0]).toMatchObject({ file: path, line: 2, severity: "error", code: "MISSING_WAIT" });
			expect(found[0]!.message).toContain("s_wait_loadcnt 0");
		},
		60_000,
	);
});
