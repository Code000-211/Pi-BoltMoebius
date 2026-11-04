import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.ts";
import { fileWritesInCommand } from "../src/core/tools/bash-file-writes.ts";

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
		expect(fileWritesInCommand(command)).toEqual([{ how, target }]);
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

	it("refuses them in the bash tool while edit is there, and runs them otherwise", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-writes-"));
		try {
			writeFileSync(join(dir, "a.txt"), "old\n");
			let editActive = true;
			const bash = createBashTool(dir, { editToolActive: () => editActive });
			await expect(bash.execute("w1", { command: "sed -i 's/old/new/' a.txt" })).rejects.toThrow(
				/^Not run: the command changes a\.txt \(sed -i\)\. Change files with edit/,
			);
			expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("old\n");
			await bash.execute("w2", { command: "echo log >> a.txt" });
			editActive = false;
			await bash.execute("w3", { command: "sed -i 's/old/new/' a.txt" });
			expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("new\nlog\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
