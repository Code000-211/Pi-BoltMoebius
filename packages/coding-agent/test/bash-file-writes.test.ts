import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileTracker } from "../src/core/file-tracking/file-tracker.ts";
import { createBashTool } from "../src/core/tools/bash.ts";
import { filesShownByCat, fileWritesInCommand } from "../src/core/tools/bash-file-writes.ts";

describe("commands that change files as edit and write would", () => {
	it.each([
		["sed -i 's/a/b/' src/x.ts", "src/x.ts", "sed -i"],
		["perl -pi -e 's/a/b/' a.c", "a.c", "perl -i"],
		["sed -i -e 's/a/b/' -e 's/c/d/' src/x.ts", "src/x.ts", "sed -i"],
		["cat > src/new.py <<'EOF'\nprint(1) > other\nEOF\necho done", "src/new.py", "a redirection"],
		["cat <<EOF > notes.md\nhi\nEOF", "notes.md", "a redirection"],
		["echo hello > README.md", "README.md", "a redirection"],
		["printf 'a\\n' | tee out.txt", "out.txt", "tee"],
		["tee notes.txt <<EOF\nx\nEOF", "notes.txt", "tee"],
		["cd src && echo a > b.txt", "b.txt", "a redirection"],
	])("finds %j", (command, target, how) => {
		expect(fileWritesInCommand(command).map(({ how, target }) => ({ how, target }))).toEqual([{ how, target }]);
	});

	it.each([
		"cd x && sed -n '1,20p' src/x.ts",
		"sed -i 's/legacy_hash(/stable_hash(/' src/mod_*.py",
		"sed -i -e 's/a/b/' src/a.py src/b.py",
		"grep -rl old src | xargs sed -i 's/old/new/'",
		"sed -i.bak -e 's/x/y/' /tmp/a /etc/hosts",
		"echo hello >> /tmp/x.log",
		"cat >> NOTES.md <<EOF\nx\nEOF",
		"tee -a log.txt <<EOF\nx\nEOF",
		"make > build.log 2>&1",
		"python3 - <<'PY' > out.json\nprint(1)\nPY",
		"ssh host 'sed -i s/a/b/ f.c'",
		"ssh host 'cat > f.c' <<'EOF'\nx\nEOF",
		"echo x >&2; ls 2>/dev/null",
		"grep -r 'echo > file' src",
		"git diff > /tmp/p.patch",
		"cd /tmp && cat > t.mjs <<EOF\nx\nEOF",
		"cd /tmp/x; cd sub; echo a > b.txt",
	])("lets %j through", (command) => {
		expect(fileWritesInCommand(command)).toEqual([]);
	});

	it("runs them in the bash tool while edit is there, and reports what changed as an edit does", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-writes-"));
		const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content[0]?.text ?? "";
		try {
			writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\nfour\n");
			let editActive = true;
			const bash = createBashTool(dir, { editToolActive: () => editActive });
			const changed = await bash.execute("w1", { command: "sed -i 's/two/2/; s/three/3/' a.txt" });
			expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("one\n2\n3\nfour\n");
			expect(text(changed)).toMatch(/a\.txt changed in lines 2-3\.$/);
			// Nothing changed: nothing to report.
			expect(text(await bash.execute("w2", { command: "sed -i 's/absent/x/' a.txt" }))).not.toMatch(/changed/);
			// An append and a new file are not watched.
			expect(text(await bash.execute("w3", { command: "echo log >> a.txt" }))).not.toMatch(/changed/);
			await bash.execute("w4", { command: "cat > b.txt <<'EOF'\nnew file\nEOF" });
			expect(readFileSync(join(dir, "b.txt"), "utf-8")).toBe("new file\n");
			editActive = false;
			expect(text(await bash.execute("w5", { command: "sed -i 's/one/1/' a.txt" }))).not.toMatch(/changed/);
			expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("1\n2\n3\nfour\nlog\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("takes a file cat printed as read at the path the command reached", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-cat-"));
		const home = process.env.HOME;
		try {
			mkdirSync(join(dir, "a", "b"), { recursive: true });
			mkdirSync(join(dir, "b"));
			writeFileSync(join(dir, "a", "b", "x"), "nested\n");
			writeFileSync(join(dir, "b", "x"), "top\n");
			writeFileSync(join(dir, "h.txt"), "home\n");
			const fileTracker = new FileTracker();
			const bash = createBashTool(dir, { fileTracker });
			await bash.execute("c1", { command: "cd a && cd b && cat x" });
			expect(fileTracker.stateTracker.hasBeenRead(join(dir, "a", "b", "x"))).toBe(true);
			expect(fileTracker.stateTracker.hasBeenRead(join(dir, "b", "x"))).toBe(false);
			process.env.HOME = dir;
			await bash.execute("c2", { command: "cat ~/h.txt" });
			expect(fileTracker.stateTracker.hasBeenRead(join(dir, "h.txt"))).toBe(true);
		} finally {
			process.env.HOME = home;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("finds files a command prints whole with cat", () => {
		expect(filesShownByCat("cat a.py b.py")).toEqual({ dir: "", files: ["a.py", "b.py"] });
		expect(filesShownByCat("cd src && cat -n x.c")).toEqual({ dir: "src", files: ["x.c"] });
		expect(filesShownByCat("cd a && cd b && cat x")).toEqual({ dir: "a/b", files: ["x"] });
		expect(filesShownByCat("cd a && cd /abs && cat x")).toEqual({ dir: "/abs", files: ["x"] });
		for (const partial of ["cat a.py | head", "cat a.py > b", "cat *.py", "cat $F", "head a.py", "cat a; rm b"]) {
			expect(filesShownByCat(partial).files).toEqual([]);
		}
	});
});
