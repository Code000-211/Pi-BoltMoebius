import { open } from "node:fs/promises";
import { splitIncompleteAnsiSuffix, stripAnsi } from "../../utils/ansi.ts";
import { createOutputFile, type OutputFile } from "../../utils/output-files.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate.ts";

export interface OutputAccumulatorOptions {
	maxLines?: number;
	maxBytes?: number;
	tempFilePrefix?: string;
	/**
	 * Keep the output as a terminal would show it: no escape sequences or control characters, and a line rewritten
	 * after a carriage return (a progress bar) only as it was last written. Snapshots, counts and the full output file
	 * then all hold the cleaned text.
	 */
	clean?: boolean;
	/** When the output is truncated, also keep its first lines, up to `headLines` and `headBytes`, before the tail. */
	headLines?: number;
	headBytes?: number;
}

export interface OutputSnapshot {
	/** The output, or when truncated its head (if kept), an omission line, and its tail. */
	content: string;
	/** What is shown: with a head, its lines and bytes count the head and the tail, not the omission line. */
	truncation: TruncationResult;
	fullOutputPath?: string;
	/** Lines of the head before the omission line, when the output is truncated and a head is kept. */
	headLines?: number;
}

export interface FullOutput {
	content: string;
	/** Whether `content` omits part of the output. */
	truncated: boolean;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

/** An open line longer than this is passed on without waiting for its end: only its last rewrite is kept. */
const MAX_OPEN_LINE_CHARS = 16 * 1024;

/** Each line as it was last written: CRLF is a newline, text before a lone carriage return was overwritten. */
function collapseCarriageReturns(text: string): string {
	if (!text.includes("\r")) return text;
	return text.replace(/\r+\n/g, "\n").replace(/^[^\n]*\r/gm, "");
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded
 * tail for display snapshots, and opens a temp file when the full output needs
 * to be preserved.
 */
export class OutputAccumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxRollingBytes: number;
	private readonly tempFilePrefix: string;
	private readonly decoder = new TextDecoder();
	private readonly clean: boolean;
	private readonly headLineLimit: number;
	private readonly headByteLimit: number;
	/** clean: an unfinished escape sequence at the end of the last chunk, and the line not yet ended. */
	private pendingAnsi = "";
	private openLine = "";
	/** The first lines, while fewer than the head limits. */
	private headText = "";
	private headLineCount = 0;
	private headFull = false;
	private pendingHead = "";

	private rawChunks: Buffer[] = [];
	private tailText = "";
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private completedLines = 0;
	private totalLines = 0;
	private currentLineBytes = 0;
	private hasOpenLine = false;
	private finished = false;

	private tempFilePath: string | undefined;
	private tempFile: OutputFile | undefined;
	/** The full output file was asked for and is missing output: not created, or a write to it failed. */
	private tempFileFailed = false;
	/** The full output file reached its size limit: the end of the output is only in memory. */
	private tempFileCapped = false;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
		this.tempFilePrefix = options.tempFilePrefix ?? "pi-output";
		this.clean = options.clean ?? false;
		this.headLineLimit = options.headLines ?? 0;
		this.headByteLimit = options.headBytes ?? 0;
		this.headFull = this.headLineLimit <= 0 || this.headByteLimit <= 0;
	}

	append(data: Buffer): void {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}
		if (this.clean) {
			this.appendCleaned(this.decoder.decode(data, { stream: true }), false);
			return;
		}

		this.totalRawBytes += data.length;
		this.appendDecodedText(this.decoder.decode(data, { stream: true }));
		this.store(data);
	}

	finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		if (this.clean) {
			this.appendCleaned(this.decoder.decode(), true);
		} else {
			this.appendDecodedText(this.decoder.decode());
		}
		if (this.shouldUseTempFile()) {
			this.ensureTempFile();
		}
	}

	private store(data: Buffer): void {
		if (this.tempFile || this.shouldUseTempFile()) {
			this.ensureTempFile();
			this.tempFile?.write(data);
		} else if (data.length > 0) {
			this.rawChunks.push(data);
		}
	}

	/** clean: passes on the complete lines of `text` (all of it at the end), cleaned, as if the command had printed them. */
	private appendCleaned(text: string, end: boolean): void {
		let complete = this.pendingAnsi + text;
		this.pendingAnsi = "";
		if (!end) {
			const split = splitIncompleteAnsiSuffix(complete);
			complete = split.complete;
			this.pendingAnsi = split.pending;
		}
		let line = this.openLine + sanitizeBinaryOutput(stripAnsi(complete));
		let ready = "";
		const lastNewline = line.lastIndexOf("\n");
		if (end) {
			ready = line.replace(/\r+$/, "");
			line = "";
		} else if (lastNewline !== -1) {
			ready = line.slice(0, lastNewline + 1);
			line = line.slice(lastNewline + 1);
		}
		if (line.length > MAX_OPEN_LINE_CHARS) {
			// A line rewritten without end (a progress bar) or very long: keep its last rewrite, or pass it on.
			line = collapseCarriageReturns(line.replace(/\r+$/, ""));
			if (line.length > MAX_OPEN_LINE_CHARS) {
				ready += line;
				line = "";
			}
		}
		this.openLine = line;
		ready = collapseCarriageReturns(ready);
		if (!ready) return;
		const data = Buffer.from(ready, "utf-8");
		this.totalRawBytes += data.length;
		this.appendDecodedText(ready);
		this.store(data);
	}

	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		const head = truncated && this.headText ? this.headText : "";
		const headLines = head ? this.headLineCount : 0;
		// While streaming, a line not yet ended shows as it was last written.
		const open = this.openLine ? collapseCarriageReturns(this.openLine.replace(/\r+$/, "")) : "";
		const tailTruncation = truncateTail(this.getSnapshotText() + open, {
			maxLines: Math.max(1, this.maxLines - headLines),
			maxBytes: Math.max(1, this.maxBytes - (head ? byteLength(head) : 0)),
		});
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
			: null;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		};

		if (options.persistIfTruncated && truncation.truncated) {
			this.ensureTempFile();
		}

		if (!head) {
			return { content: truncation.content, truncation, fullOutputPath: this.tempFilePath };
		}
		const omitted = this.totalLines - headLines - truncation.outputLines;
		const content = `${head}\n[... ${omitted} lines omitted ...]\n\n${truncation.content}`;
		return {
			content,
			truncation: {
				...truncation,
				content,
				outputLines: headLines + truncation.outputLines,
				outputBytes: byteLength(head) + truncation.outputBytes,
			},
			fullOutputPath: this.tempFilePath,
			headLines,
		};
	}

	/** Close the full output file. Throws the error of a failed write to it. */
	closeTempFile(): void {
		const file = this.tempFile;
		this.tempFile = undefined;
		if (file?.failed) this.tempFileFailed = true;
		if (file?.capped) this.tempFileCapped = true;
		file?.close();
	}

	/**
	 * The complete output, for callers that can take more than the display snapshot. Call after
	 * `finish()` and `closeTempFile()`. Output longer than `maxBytes` raw bytes keeps its first and
	 * last `maxBytes / 2` bytes around an omission marker.
	 */
	async readFullOutput(maxBytes: number): Promise<FullOutput> {
		if (this.tempFileFailed) {
			return this.readTailOutput(maxBytes);
		}
		if (!this.tempFilePath) {
			if (this.tailStartsAtLineBoundary && this.totalDecodedBytes <= maxBytes) {
				return { content: this.tailText, truncated: false };
			}
			return { content: new TextDecoder().decode(Buffer.concat(this.rawChunks)), truncated: false };
		}
		let file: Awaited<ReturnType<typeof open>>;
		try {
			file = await open(this.tempFilePath, "r");
		} catch {
			return this.readTailOutput(maxBytes);
		}
		try {
			const size = (await file.stat()).size;
			if (size <= maxBytes && !this.tempFileCapped) {
				return { content: new TextDecoder().decode(await file.readFile()), truncated: false };
			}
			const headBytes = Math.floor(maxBytes / 2);
			const tailBytes = maxBytes - headBytes;
			const head = Buffer.alloc(headBytes);
			const { bytesRead } = await file.read(head, 0, headBytes, 0);
			// Cut at character boundaries: streaming decode holds back an incomplete trailing sequence,
			// and the tail skips leading continuation bytes.
			const headText = new TextDecoder().decode(head.subarray(0, bytesRead), { stream: true });
			if (this.tempFileCapped) {
				// The file stops at its size limit, so its end is not the output's: that is the tail kept in memory.
				const tailText = truncateTail(this.getSnapshotText(), {
					maxLines: Number.MAX_SAFE_INTEGER,
					maxBytes: tailBytes,
				}).content;
				const omitted = this.totalRawBytes - bytesRead - byteLength(tailText);
				return { content: `${headText}\n\n[... ${omitted} bytes omitted ...]\n\n${tailText}`, truncated: true };
			}
			const tail = Buffer.alloc(tailBytes);
			await file.read(tail, 0, tailBytes, size - tailBytes);
			let tailStart = 0;
			while (tailStart < tail.length && (tail[tailStart] & 0xc0) === 0x80) tailStart++;
			const tailText = new TextDecoder().decode(tail.subarray(tailStart));
			const omitted = size - headBytes - tailBytes;
			return { content: `${headText}\n\n[... ${omitted} bytes omitted ...]\n\n${tailText}`, truncated: true };
		} finally {
			await file.close();
		}
	}

	/** What is kept in memory, the end of the output, for when the full output file cannot be read. */
	private readTailOutput(maxBytes: number): FullOutput {
		const tail = truncateTail(this.getSnapshotText(), { maxLines: Number.MAX_SAFE_INTEGER, maxBytes });
		return { content: tail.content, truncated: true };
	}

	getLastLineBytes(): number {
		return this.currentLineBytes;
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) {
			return;
		}

		const bytes = byteLength(text);
		if (!this.headFull) this.appendHead(text);
		this.totalDecodedBytes += bytes;
		this.tailText += text;
		this.tailBytes += bytes;
		if (this.tailBytes > this.maxRollingBytes * 2) {
			this.trimTail();
		}

		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			this.currentLineBytes += bytes;
			this.hasOpenLine = true;
		} else {
			this.completedLines += newlines;
			const tail = text.slice(lastNewline + 1);
			this.currentLineBytes = byteLength(tail);
			this.hasOpenLine = tail.length > 0;
		}
		this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
	}

	/** Keeps the first complete lines of the output, as many as fit in the head limits. */
	private appendHead(text: string): void {
		let start = 0;
		let headBytes = byteLength(this.headText);
		while (!this.headFull) {
			const newline = text.indexOf("\n", start);
			if (newline === -1) {
				// The rest of a line still open: kept once it ends and fits.
				this.pendingHead += text.slice(start);
				if (byteLength(this.pendingHead) > this.headByteLimit) this.headFull = true;
				return;
			}
			const line = this.pendingHead + text.slice(start, newline);
			this.pendingHead = "";
			const lineBytes = byteLength(line) + 1;
			if (headBytes + lineBytes > this.headByteLimit) {
				this.headFull = true;
				return;
			}
			this.headText += `${line}\n`;
			headBytes += lineBytes;
			if (++this.headLineCount >= this.headLineLimit) this.headFull = true;
			start = newline + 1;
		}
	}

	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf-8");
		if (buffer.length <= this.maxRollingBytes) {
			this.tailBytes = buffer.length;
			return;
		}

		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
			start++;
		}

		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = byteLength(this.tailText);
	}

	private getSnapshotText(): string {
		if (this.tailStartsAtLineBoundary) {
			return this.tailText;
		}

		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines
		);
	}

	private ensureTempFile(): void {
		if (this.tempFilePath || this.tempFileFailed) {
			return;
		}
		const file = createOutputFile(this.tempFilePrefix, ".log");
		if (!file.opened) {
			// Not created (no temp directory, no free descriptor): the output keeps its tail in memory, and says so.
			this.tempFileFailed = true;
			this.rawChunks = [];
			return;
		}
		this.tempFilePath = file.path;
		this.tempFile = file;
		for (const chunk of this.rawChunks) {
			file.write(chunk);
		}
		this.rawChunks = [];
	}
}
