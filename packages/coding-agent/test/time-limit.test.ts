import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTimeLimit, TimeLimitClock, timeLimitSection, timeNotice } from "../src/core/time-limit.ts";

describe("time limit", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("reads PI_TIME_LIMIT in seconds and ignores what is not a positive number", () => {
		expect(parseTimeLimit("900")).toBe(900_000);
		expect(parseTimeLimit("90.5")).toBe(90_500);
		for (const value of [undefined, "", "0", "-5", "soon"]) expect(parseTimeLimit(value)).toBeUndefined();
	});

	it("names the limit in the system prompt", () => {
		expect(timeLimitSection(900_000)).toContain("time limit of 15 min");
		expect(timeLimitSection(150_000)).toContain("time limit of 2.5 min");
	});

	it("tells what is left at half, three quarters and nine tenths, and stops telling once stopped", () => {
		const told: string[] = [];
		const clock = new TimeLimitClock(900_000, (text) => told.push(text));
		vi.advanceTimersByTime(800_000);
		expect(told).toEqual([]); // not started
		clock.start();
		clock.start();
		vi.advanceTimersByTime(450_000);
		expect(told).toEqual([timeNotice(0.5, 900_000)]);
		expect(told[0]).toContain("7.5 min of 15 min left");
		vi.advanceTimersByTime(225_000);
		expect(told[1]).toContain("3.8 min left");
		clock.stop();
		vi.advanceTimersByTime(900_000);
		expect(told).toHaveLength(2);
	});

	it("asks to finish at nine tenths", () => {
		expect(timeNotice(0.9, 900_000)).toBe("Time: 1.5 min left. Finish now: save the result as it is and stop.");
	});
});
