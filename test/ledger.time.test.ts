import { describe, expect, test } from "bun:test";
import { elapsedMs, formatElapsed, newLedger } from "../src/ledger";

describe("ledger — wall-clock budget reporting", () => {
	test("newLedger stamps startedAt so elapsed time is measurable", () => {
		const led = newLedger("r", "task", "demo", { k: 1, mode: "parallel", profile: "small" });
		expect(typeof led.startedAt).toBe("string");
		expect(Number.isFinite(Date.parse(led.startedAt ?? ""))).toBe(true);
	});

	test("elapsedMs measures from startedAt and is 0 for a legacy ledger", () => {
		const led = newLedger("r", "task", "demo", { k: 1, mode: "parallel", profile: "small" });
		const start = Date.parse(led.startedAt ?? "");
		expect(elapsedMs(led, start + 192_000)).toBe(192_000);
		delete led.startedAt;
		expect(elapsedMs(led, Date.now())).toBe(0);
	});

	test("formatElapsed is compact and readable", () => {
		expect(formatElapsed(0)).toBe("0s");
		expect(formatElapsed(7_400)).toBe("7s");
		expect(formatElapsed(192_000)).toBe("3m12s");
		expect(formatElapsed(600_000)).toBe("10m00s");
	});
});
