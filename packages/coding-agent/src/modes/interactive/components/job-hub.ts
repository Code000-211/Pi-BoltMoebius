/**
 * Job hub: the session's background jobs, as in oh-my-pi's agent hub, without subagents.
 *
 * A list of the jobs, newest first, with the selected one's details and the end of its output below; Enter shows its
 * whole output (what the bash tool keeps: the first lines and the end), x stops it. Running jobs update live.
 */

import { type Component, type Focusable, getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { BackgroundJob, BackgroundJobStatus, BackgroundJobs } from "../../../core/background-jobs.ts";
import { DEFAULT_AUTO_BACKGROUND_SECONDS } from "../../../core/tools/bash.ts";
import { theme } from "../theme/theme.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

/** How often the hub draws again while it is open: running times and output change on their own. */
const REFRESH_MS = 500;

const STATUS_STYLE: Record<
	BackgroundJobStatus,
	{ mark: string; color: "accent" | "success" | "error" | "warning" | "muted" }
> = {
	running: { mark: "●", color: "accent" },
	done: { mark: "✓", color: "success" },
	failed: { mark: "✗", color: "error" },
	"timed out": { mark: "⏱", color: "warning" },
	killed: { mark: "■", color: "muted" },
};

export function formatJobDuration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function statusText(job: BackgroundJob): string {
	if (job.status === "failed" && job.exitCode !== null && job.exitCode !== undefined) return `exit ${job.exitCode}`;
	return job.status;
}

function padded(text: string, width: number): string {
	const cut = truncateToWidth(text, width);
	return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

export interface JobHubOptions {
	/** Rows the hub may take. */
	rows: () => number;
	requestRender: () => void;
	onClose: () => void;
}

export class JobHubComponent implements Component, Focusable {
	focused = false;
	private selected = 0;
	/** Showing the selected job's whole output, scrolled this many lines up from its end. */
	private outputScroll: number | undefined;
	private readonly timer: ReturnType<typeof setInterval>;
	private readonly unsubscribe: () => void;
	private readonly jobs: BackgroundJobs;
	private readonly options: JobHubOptions;

	constructor(jobs: BackgroundJobs, options: JobHubOptions) {
		this.jobs = jobs;
		this.options = options;
		this.timer = setInterval(() => {
			if (this.jobs.running().length > 0) this.options.requestRender();
		}, REFRESH_MS);
		this.timer.unref?.();
		this.unsubscribe = this.jobs.subscribe(() => this.options.requestRender());
	}

	/** Newest first. */
	private list(): BackgroundJob[] {
		return [...this.jobs.list()].reverse();
	}

	private current(): BackgroundJob | undefined {
		const list = this.list();
		this.selected = Math.min(this.selected, Math.max(0, list.length - 1));
		return list[this.selected];
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const job = this.current();
		if (this.outputScroll !== undefined) {
			const page = Math.max(1, this.options.rows() - 4);
			if (kb.matches(data, "tui.select.cancel") || kb.matches(data, "tui.select.confirm"))
				this.outputScroll = undefined;
			else if (kb.matches(data, "tui.select.up")) this.outputScroll++;
			else if (kb.matches(data, "tui.select.down")) this.outputScroll = Math.max(0, this.outputScroll - 1);
			else if (kb.matches(data, "tui.select.pageUp")) this.outputScroll += page;
			else if (kb.matches(data, "tui.select.pageDown")) this.outputScroll = Math.max(0, this.outputScroll - page);
			else return;
			this.options.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.options.onClose();
			return;
		}
		const count = this.jobs.list().length;
		if (kb.matches(data, "tui.select.up") || kb.matches(data, "app.jobs.up"))
			this.selected = Math.max(0, this.selected - 1);
		else if (kb.matches(data, "tui.select.down") || kb.matches(data, "app.jobs.down"))
			this.selected = Math.min(count - 1, this.selected + 1);
		else if (kb.matches(data, "tui.select.confirm") && job) this.outputScroll = 0;
		else if (kb.matches(data, "app.jobs.stop") && job?.status === "running") this.jobs.kill(job.id);
		else return;
		this.options.requestRender();
	}

	render(width: number): string[] {
		const rows = Math.max(8, this.options.rows());
		const job = this.current();
		if (job && this.outputScroll !== undefined) return this.renderOutput(job, width, rows);

		const all = this.jobs.list();
		const running = all.filter((j) => j.status === "running").length;
		const lines: string[] = [];
		const rule = theme.fg("border", "─".repeat(width));
		lines.push(rule);
		lines.push(
			padded(
				`${theme.bold("Jobs")}${theme.fg("muted", `  ${running} running · ${all.length - running} ended`)}`,
				width,
			),
		);
		lines.push(rule);

		const now = Date.now();
		const list = this.list();
		if (list.length === 0) {
			lines.push(
				theme.fg(
					"muted",
					`No background jobs in this session. A bash command still running after ${DEFAULT_AUTO_BACKGROUND_SECONDS / 60} minutes,`,
				),
			);
			lines.push(theme.fg("muted", "or one the agent starts with background: true, shows up here."));
		}
		// Up to a third of the rows for the list, the rest for the selected job.
		const listRows = Math.min(list.length, Math.max(3, Math.floor(rows / 3)));
		const first = Math.min(Math.max(0, this.selected - listRows + 1), Math.max(0, list.length - listRows));
		for (let i = first; i < first + listRows && i < list.length; i++) {
			const j = list[i]!;
			const style = STATUS_STYLE[j.status];
			const pointer = i === this.selected ? theme.fg("accent", "›") : " ";
			const time = formatJobDuration((j.endedAt ?? now) - j.startedAt);
			const head = `${pointer} ${theme.fg(style.color, style.mark)} ${j.id.padEnd(5)} ${theme.fg(style.color, statusText(j).padEnd(9))} ${theme.fg("muted", time.padStart(7))}  `;
			const command =
				i === this.selected ? j.command.replace(/\s+/g, " ") : theme.fg("text", j.command.replace(/\s+/g, " "));
			lines.push(padded(head + command, width));
		}

		if (job) {
			lines.push(rule);
			const details = [
				`${theme.fg("muted", "command")} ${job.command.replace(/\s+/g, " ")}`,
				`${theme.fg("muted", "cwd")} ${job.cwd}${job.pid ? theme.fg("muted", "  pid ") + job.pid : ""}`,
				`${theme.fg("muted", "started")} ${new Date(job.startedAt).toLocaleTimeString()}${theme.fg("muted", "  background since ")}${new Date(job.backgroundedAt).toLocaleTimeString()}${job.endedAt ? theme.fg("muted", "  ended ") + new Date(job.endedAt).toLocaleTimeString() : ""}`,
				`${theme.fg("muted", "output")} ${job.outputFile ?? "(in memory)"}${job.reported ? theme.fg("muted", "  · reported to the agent") : ""}`,
			];
			for (const line of details) lines.push(padded(line, width));
			lines.push(rule);
			const room = rows - lines.length - 2;
			if (room > 0) {
				const output = this.jobs.output(job.id).replace(/\n$/, "").split("\n");
				const shown = output.slice(-room);
				for (const line of shown) lines.push(padded(theme.fg("toolOutput", line), width));
				for (let i = shown.length; i < room; i++) lines.push("");
			}
		}

		lines.push(rule);
		const hints = [
			rawKeyHint("↑↓", "select"),
			keyHint("tui.select.confirm", "output"),
			...(job?.status === "running" ? [keyHint("app.jobs.stop", "stop")] : []),
			keyHint("tui.select.cancel", "close"),
		];
		lines.push(padded(hints.join(theme.fg("muted", " · ")), width));
		return lines.slice(0, rows);
	}

	private renderOutput(job: BackgroundJob, width: number, rows: number): string[] {
		const output = this.jobs.output(job.id).replace(/\n$/, "").split("\n");
		const room = Math.max(1, rows - 4);
		const maxScroll = Math.max(0, output.length - room);
		this.outputScroll = Math.min(this.outputScroll ?? 0, maxScroll);
		const end = output.length - this.outputScroll;
		const shown = output.slice(Math.max(0, end - room), end);
		const rule = theme.fg("border", "─".repeat(width));
		const lines = [
			rule,
			padded(`${theme.bold(job.id)}  ${theme.fg("muted", job.command.replace(/\s+/g, " "))}`, width),
			...shown.map((line) => padded(theme.fg("toolOutput", line), width)),
		];
		while (lines.length < rows - 2) lines.push("");
		lines.push(rule);
		const position = this.outputScroll > 0 ? theme.fg("muted", `${this.outputScroll} lines above the end · `) : "";
		lines.push(
			padded(
				position +
					[rawKeyHint("↑↓ pgup pgdn", "scroll"), keyHint("tui.select.cancel", "back")].join(
						theme.fg("muted", " · "),
					),
				width,
			),
		);
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
		this.unsubscribe();
	}
}

/** The status line text while jobs run, or undefined. */
export function jobStatusText(jobs: BackgroundJobs, hubKey: string): string | undefined {
	const running = jobs.running().length;
	if (running === 0) return undefined;
	return `${theme.fg("accent", "●")} ${running} ${running === 1 ? "job" : "jobs"} running${hubKey ? theme.fg("dim", ` (${hubKey})`) : ""}`;
}
