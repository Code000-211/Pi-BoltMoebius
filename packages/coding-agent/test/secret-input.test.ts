import { stripVTControlCharacters } from "node:util";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SecretInputComponent } from "../src/modes/interactive/components/secret-input.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));
beforeEach(() => setKeybindings(new KeybindingsManager()));

describe("secret input", () => {
	it("shows dots, not the text, and answers on Enter", () => {
		const answers: Array<string | undefined> = [];
		const input = new SecretInputComponent("Enter passphrase for key '/k':", (a) => answers.push(a));
		for (const key of ["s", "3", "c", "x", "\x7f", "r3t"]) input.handleInput(key);
		const screen = input.render(60).map((l) => stripVTControlCharacters(l));
		expect(screen[1]?.trimEnd()).toBe("Enter passphrase for key '/k':");
		expect(screen[2]?.trimEnd()).toBe("› ••••••");
		expect(screen.join("\n")).not.toContain("s3c");
		expect(screen.every((l) => l.length === 60)).toBe(true);
		input.handleInput("\r");
		expect(answers).toEqual(["s3cr3t"]);
	});

	it("gives up on Escape", () => {
		const answers: Array<string | undefined> = [];
		const input = new SecretInputComponent("Password:", (a) => answers.push(a));
		input.handleInput("abc");
		input.handleInput("\x1b");
		expect(answers).toEqual([undefined]);
	});
});
