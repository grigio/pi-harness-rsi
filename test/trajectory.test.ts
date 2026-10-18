import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSessionJsonl } from "../src/fake";
import { findSessionFile } from "../src/probe";
import { digest, sessionUsd, summarizeSession, writtenPaths } from "../src/trajectory";

/** Minimal, faithful pi session JSONL (see docs/session-format.md). */
function jsonl(entries: unknown[]): string {
	return `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

const withCall = jsonl([
	{ type: "session", version: 3, id: "s1" },
	{ type: "message", message: { role: "user", content: "task: fix the flaky check" } },
	{
		type: "message",
		message: {
			role: "assistant",
			model: "test-model",
			content: [
				{ type: "text", text: "Running the checks first." },
				{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } },
			],
			usage: { totalTokens: 100, cost: { total: 0.01 } },
		},
	},
	{
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "bash",
			content: "FAIL tests/a.test.ts\nexit code 1",
			isError: true,
		},
	},
	{
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "c2", name: "write", arguments: { path: "AGENTS.md" } }],
			usage: { totalTokens: 50, cost: { total: 0.02 } },
		},
	},
	{
		type: "message",
		message: { role: "toolResult", toolCallId: "c2", toolName: "write", content: "ok" },
	},
]);

describe("digest — fixed shape, capped (P0 obs_trunc fix)", () => {
	const cap = 6_000;

	test("always the same sections, even for an empty session", () => {
		const out = digest({ label: "ref0", sessionJsonl: "", cap });
		for (const section of ["# digest: ref0", "tools:", "errors:", "deliverable:", "first_divergence:", "rework:"]) {
			expect(out.text).toContain(section);
		}
		expect(out.capped).toBe(false);
		expect(out.dropped).toEqual([]);
	});

	test("pairs calls with results: counts tools once, flags the failing one", () => {
		const out = digest({ label: "c0", sessionJsonl: withCall, cap });
		expect(out.text).toContain("tools: bash×1 (1 err) write×1");
		expect(out.text).toContain("FAIL tests/a.test.ts");
		expect(out.text).toContain("exit=1");
		expect(out.text).toContain("first_divergence: @step=0");
		expect(out.text).toContain("turns=2");
	});

	test("evidence lines are evidence: verifier/diff/deliverable, never a score", () => {
		const out = digest({
			label: "c1",
			sessionJsonl: withCall,
			cap,
			verifier: "tsc exit=0; npm test exit=1",
			diffStat: "+12 −3",
			deliverables: ["AGENTS.md"],
			pointer: "sessions/c1.jsonl",
		});
		expect(out.text).toContain("verifier: tsc exit=0; npm test exit=1");
		expect(out.text).toContain("deliverable: AGENTS.md | git-diff: +12 −3");
		expect(out.text).toContain("full session: sessions/c1.jsonl");
		expect(out.text).not.toMatch(/score[:=]/i);
	});

	test("overflow drops sections (never slices) and says which", () => {
		const out = digest({ label: "c2", sessionJsonl: withCall, cap: 260 });
		expect(out.capped).toBe(true);
		expect(out.dropped.length).toBeGreaterThan(0);
		expect([...out.text].length).toBeLessThanOrEqual(260);
		expect(out.text).toContain("# digest: c2"); // header is never dropped
		expect(out.text).toMatch(/dropped: over \d+-char digest budget/);
	});

	test("deterministic: same input, same bytes (comparisons stay meaningful)", () => {
		const a = digest({ label: "c0", sessionJsonl: withCall, cap });
		const b = digest({ label: "c0", sessionJsonl: withCall, cap });
		expect(a.text).toBe(b.text);
	});
});

test("sessionUsd sums provider-reported cost from the jsonl", () => {
	expect(sessionUsd(withCall)).toBeCloseTo(0.03, 6);
	expect(sessionUsd("")).toBe(0);
	expect(sessionUsd("{broken json\n")).toBe(0);
});

test("summarizeSession: turns, models, steps, orphans", () => {
	const s = summarizeSession(withCall);
	expect(s.turns).toBe(2);
	expect(s.models).toEqual(["test-model"]);
	expect(s.steps).toHaveLength(2);
	expect(s.steps[0]?.isError).toBe(true);
	// an assistant call with no toolResult still appears (aborted run)
	const orphan = jsonl([
		{
			type: "message",
			message: { role: "assistant", content: [{ type: "toolCall", id: "z", name: "bash", arguments: {} }] },
		},
	]);
	expect(summarizeSession(orphan).steps).toHaveLength(1);
	expect(summarizeSession(orphan).steps[0]?.isError).toBe(true);
});

test("writtenPaths harvests deliverables from edit tools", () => {
	expect(writtenPaths(withCall)).toContain("AGENTS.md");
	expect(writtenPaths(withCall, ["AGENTS.md"])).toEqual(["AGENTS.md"]);
	expect(writtenPaths(withCall, ["src"])).toEqual([]);
});

describe("session discovery for evidence", () => {
	test("findSessionFile walks the evidence tree", () => {
		const dir = mkdtempSync(join(tmpdir(), "rsi-ev-"));
		mkdirSync(join(dir, "sessions"), { recursive: true });
		writeFileSync(join(dir, "sessions", "one.jsonl"), "{}\n");
		expect(findSessionFile(dir)).toBe(join(dir, "sessions", "one.jsonl"));
		expect(findSessionFile(mkdtempSync(join(tmpdir(), "rsi-ev2-")))).toBeUndefined();
	});

	test("fake session jsonl is parseable by the real digest", () => {
		const fake = fakeSessionJsonl({ label: "c0", prompt: "task: whatever", kind: "rollout" });
		const out = digest({ label: "c0", sessionJsonl: fake, cap: 4_000 });
		expect(out.text).toContain("# digest: c0");
		expect(out.text).toContain("tools:");
		expect(sessionUsd(fake)).toBeGreaterThan(0);
	});
});
