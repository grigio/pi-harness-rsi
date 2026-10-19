import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../src/config";
import { addEntry, elapsedMs, formatElapsed, newLedger, renderStatus } from "../src/ledger";

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

	test("a finished ledger measures to endedAt, not to the current clock", () => {
		const led = newLedger("r", "task", "demo", { k: 1, mode: "parallel", profile: "small" });
		const start = Date.parse(led.startedAt ?? "");
		led.outcome = "aborted_timeout";
		led.endedAt = new Date(start + 300_000).toISOString();
		// One hour later: the run still lasted five minutes, not an hour.
		expect(elapsedMs(led, start + 3_600_000)).toBe(300_000);
	});

	test("a legacy finished ledger stops at its last entry", () => {
		const led = newLedger("r", "task", "demo", { k: 1, mode: "parallel", profile: "small" });
		const start = Date.parse(led.startedAt ?? "");
		delete led.endedAt;
		led.outcome = "aborted_timeout";
		addEntry(led, { kind: "rollout", label: "ref0", usd: 0, attempts: 1 });
		const entry = led.entries[0];
		if (entry) entry.ts = new Date(start + 240_000).toISOString();
		expect(elapsedMs(led, start + 3_600_000)).toBe(240_000);
	});

	test("formatElapsed is compact and readable", () => {
		expect(formatElapsed(0)).toBe("0s");
		expect(formatElapsed(7_400)).toBe("7s");
		expect(formatElapsed(192_000)).toBe("3m12s");
		expect(formatElapsed(600_000)).toBe("10m00s");
	});
});

describe("ledger status — incomplete runs are not corruption", () => {
	const cfg = resolveConfig({}, {} as NodeJS.ProcessEnv);

	test("an aborted run reports incomplete, not IDENTITY MISMATCH", () => {
		const led = newLedger("r", "task", "demo", { k: 2, mode: "parallel", profile: "small" });
		addEntry(led, { kind: "rollout", label: "ref0", usd: 0, attempts: 1 });
		addEntry(led, { kind: "session", label: "inv0", usd: 0, attempts: 1 });
		led.outcome = "aborted_timeout";
		const text = renderStatus({ ledger: led, cfg });
		expect(text).toContain("incomplete (aborted_timeout");
		expect(text).not.toContain("IDENTITY MISMATCH");
	});

	test("a finished run with missing entries still reports a real mismatch", () => {
		const led = newLedger("r", "task", "demo", { k: 2, mode: "parallel", profile: "small" });
		addEntry(led, { kind: "rollout", label: "ref0", usd: 0, attempts: 1 });
		led.outcome = "adopted";
		const text = renderStatus({ ledger: led, cfg });
		expect(text).toContain("IDENTITY MISMATCH");
	});
});
