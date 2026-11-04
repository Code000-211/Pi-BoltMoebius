/**
 * A question whose answer is not shown: a passphrase or password ssh asks for. Typed characters show as dots, Enter
 * answers, Escape gives up.
 */

import { type Component, type Focusable, getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";

export class SecretInputComponent implements Component, Focusable {
	focused = false;
	private value = "";
	private readonly prompt: string;
	private readonly done: (answer: string | undefined) => void;

	constructor(prompt: string, done: (answer: string | undefined) => void) {
		this.prompt = prompt;
		this.done = done;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.value = "";
			this.done(undefined);
		} else if (kb.matches(data, "tui.select.confirm") || data === "\r" || data === "\n") {
			const answer = this.value;
			this.value = "";
			this.done(answer);
		} else if (data === "\x7f" || data === "\b") {
			this.value = this.value.slice(0, -1);
		} else if (data === "\x15") {
			this.value = "";
		} else if ([...data].every((c) => c >= " " && c !== "\x7f")) {
			this.value += data;
		}
	}

	render(width: number): string[] {
		// Padded to the full width: the dialog covers what is behind it.
		const fit = (text: string) => {
			const cut = truncateToWidth(text, width);
			return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
		};
		const rule = theme.fg("border", "─".repeat(width));
		return [
			rule,
			fit(theme.bold(this.prompt)),
			fit(`${theme.fg("accent", "›")} ${"•".repeat(this.value.length)}`),
			fit(
				`${keyHint("tui.select.confirm", "answer")}${theme.fg("muted", " · ")}${keyHint("tui.select.cancel", "give up")}${theme.fg("muted", " · not shown, not kept")}`,
			),
			rule,
		];
	}

	invalidate(): void {}
}
