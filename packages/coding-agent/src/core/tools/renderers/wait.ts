/**
 * Presentation for the wait tool: its call, and the report of the jobs that ended (first lines, more when expanded).
 */

import { Text } from "@earendil-works/pi-tui";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { ToolDefinition } from "../../extensions/types.ts";
import { getTextOutput } from "../render-utils.ts";
import { declarePlainRenderers } from "./highlighting.ts";

export const waitRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(_args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(theme.fg("toolTitle", theme.bold("wait")));
		return text;
	},
	renderResult(result, options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		const lines = getTextOutput(result as any, context.showImages)
			.trim()
			.split("\n");
		const shown = options.expanded ? lines : lines.slice(0, 6);
		let out = `\n${shown.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (shown.length < lines.length) {
			out += `${theme.fg("muted", `\n... (${lines.length - shown.length} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
		text.setText(out);
		return text;
	},
};

declarePlainRenderers(waitRenderers);
