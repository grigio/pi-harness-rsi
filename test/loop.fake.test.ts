import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config";
import { addEntry, assertIdentity, countRP, loadLedger, newLedger } from "../src/ledger";
import { heldRunLock, lockPath } from "../src/lock";
import { type LoopReport, runLoop, runReferenceProbes, statusOfRun } from "../src/loop";

function makeCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "rsi-loop-"));
	// an empty project: no AGENTS.md (the loop synthesizes one for the run)
	writeFileSync(join(dir, "README.md"), "# demo project\n");
	return dir;
}

function fakeCfg(env: Record<string, string> = {}, overrides: Record<string, unknown> = {}) {
	return resolveConfig({ profile: "small", k: 1, ...overrides }, { PI_RSI_FAKE: "1", ...env } as NodeJS.ProcessEnv);
}

async function run(cwd: string, cfg: ReturnType<typeof fakeCfg>, runId: string): Promise<LoopReport> {
	const logs: string[] = [];
	const report = await runLoop({
		cfg,
		cwd,
		task: "keep the checks green while editing",
		domain: "demo",
		force: true,
		runId,
		io: { log: (m) => logs.push(m), confirmAdoption: async () => true },
	});
	(report as LoopReport & { logs?: string[] }).logs = logs;
	return report;
}

describe("full fake loop (PI_RSI_FAKE=1, zero model calls)", () => {
	test("happy path: probe → INV/DOM → probe → compose → probe → select → adopt → reflect", async () => {
		const cwd = makeCwd();
		const report = await run(cwd, fakeCfg(), "fake-happy");

		expect(report.outcome).toBe("adopted");
		expect(report.adopted).toBe(true);
		expect(report.chosen).toBe("final0");

		// R = 4k (1 ref + 2 candidate probes + 1 final), P = 3k (inv + dom + compose)
		expect(report.identity.ok).toBe(true);
		expect(report.identity.actual).toEqual({ R: 4, P: 3 });
		expect(report.usd).toBeGreaterThan(0);
		expect(report.usd).toBeLessThanOrEqual(2);

		// run layout: ledger, report, status, task, base snapshot, digests, evidence
		const runDir = join(cwd, ".pi", "harness", "runs", "fake-happy");
		expect(existsSync(join(runDir, "ledger.json"))).toBe(true);
		expect(existsSync(join(runDir, "report.json"))).toBe(true);
		expect(existsSync(join(runDir, "status.txt"))).toBe(true);
		expect(existsSync(join(runDir, "task.txt"))).toBe(true);
		expect(existsSync(join(runDir, "base", "surface.json"))).toBe(true);
		expect(existsSync(join(runDir, "digests", "ref0.md"))).toBe(true);
		expect(existsSync(join(runDir, "selection.json"))).toBe(true);
		expect(existsSync(join(runDir, "surfaces", "final0.json"))).toBe(true);

		// adoption actually updated the live surface and snapshotted the library
		const agents = readFileSync(join(cwd, "AGENTS.md"), "utf8");
		expect(agents).toContain("procedure");
		expect(existsSync(join(cwd, ".pi", "skills", "demo-notes", "SKILL.md"))).toBe(true);
		const domainDir = join(cwd, ".pi", "harness", "library", "demo");
		expect(existsSync(domainDir)).toBe(true);
		const index = readFileSync(join(cwd, ".pi", "harness", "library", "demo", "INDEX.md"), "utf8");
		expect(index).toContain("keep-the-checks-green-while-editing"); // lesson summary row
		expect(existsSync(join(domainDir, "keep-the-checks-green-while-editing", "EXPERIENCE.md"))).toBe(true);

		// k=1: the selection stage does not exist
		const selection = JSON.parse(readFileSync(join(runDir, "selection.json"), "utf8"));
		expect(selection.trivial).toBe(true);
		expect(selection.why).toContain("k=1");

		// the cross-process lock is released when the run closes
		expect(heldRunLock(cwd)).toBeUndefined();

		// status renders the identity line
		const status = statusOfRun({ cwd, runId: "fake-happy", cfg: fakeCfg() });
		expect(status.ok).toBe(true);
		expect(status.text).toContain("identity OK");
		expect(status.text).toContain("outcome: adopted");
	}, 60_000);

	test("invalid-first: the retry carries the verbatim validator error, identity holds", async () => {
		const cwd = makeCwd();
		const report = await run(cwd, fakeCfg({ PI_RSI_FAKE_SCENARIO: "invalid-first" }), "fake-retry");

		expect(report.outcome).toBe("adopted");
		expect(report.identity.ok).toBe(true);
		expect(report.identity.actual).toEqual({ R: 4, P: 3 }); // retries do not inflate P

		const ledger = loadLedger(join(cwd, ".pi", "harness", "runs", "fake-retry"));
		expect(ledger).toBeDefined();
		expect(ledger?.counters.editorErrors).toBe(0); // spawn-level errors: none
		expect(ledger?.counters.fellBack).toBe(0); // the retry succeeded — no fallback
		expect(report.notes.join("\n")).toContain("validation failed (attempt 1/2)"); // verbatim retry feedback path
		// the retry mission carries the validator's own words (P3)
		const retryMission = readFileSync(
			join(cwd, ".pi", "harness", "runs", "fake-retry", "missions", "propose-inv0-a1.md"),
			"utf8",
		);
		expect(retryMission).toContain("validator feedback (fix exactly this, nothing else)");
		expect(retryMission).toMatch(/traversal|escape/);
	}, 60_000);

	test("always-invalid: fail closed to the base surface, ledger still closes at 4k/3k", async () => {
		const cwd = makeCwd();
		const report = await run(cwd, fakeCfg({ PI_RSI_FAKE_SCENARIO: "always-invalid" }), "fake-fallback");

		expect(report.identity.ok).toBe(true);
		expect(report.identity.actual).toEqual({ R: 4, P: 3 });
		const ledger = loadLedger(join(cwd, ".pi", "harness", "runs", "fake-fallback"));
		expect(ledger?.counters.fellBack).toBeGreaterThanOrEqual(3); // inv + dom + compose
		expect(report.notes.join("\n")).toContain("fell back");
		// nothing valid was adopted: the live surface is still the synthesized one
		expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toContain("# Project instructions");
	}, 60_000);

	test("k=2: selection stage runs — anonymized pool, seeded choice, diversity measured", async () => {
		const cwd = makeCwd();
		const report = await run(cwd, fakeCfg({}, { k: 2 }), "fake-k2");

		// R = 4k = 8 (2 refs + 4 candidate probes + 2 finals), P = 3k = 6
		expect(report.outcome).toBe("adopted");
		expect(report.identity.ok).toBe(true);
		expect(report.identity.actual).toEqual({ R: 8, P: 6 });

		const runDir = join(cwd, ".pi", "harness", "runs", "fake-k2");
		const selection = JSON.parse(readFileSync(join(runDir, "selection.json"), "utf8"));
		expect(selection.trivial).toBe(false);
		expect(selection.order.map((o: { id: string }) => o.id)).toEqual(["c0", "c1"]);
		// labels stay hidden from the judge — the identity map lives only here
		expect(JSON.stringify(selection)).toContain("final0");
		expect(typeof loadLedger(runDir)?.diversity).toBe("number"); // mode-collapse signal measured
		// both composed surfaces exist for audit
		expect(existsSync(join(runDir, "surfaces", "final0.json"))).toBe(true);
		expect(existsSync(join(runDir, "surfaces", "final1.json"))).toBe(true);
	}, 60_000);

	test("USD budget stop fails closed before wasting spend", async () => {
		const cwd = makeCwd();
		const cfg = fakeCfg({ PI_RSI_MAX_USD: "0.000001" });
		const report = await run(cwd, cfg, "fake-budget");
		expect(report.outcome).toBe("aborted_budget");
		expect(report.usd).toBeLessThanOrEqual(cfg.maxUsd + 0.01);
	}, 60_000);

	test("/rsi probe: reference executions only, R=k, identity exempt", async () => {
		const cwd = makeCwd();
		const report = await runReferenceProbes({
			cfg: fakeCfg(),
			cwd,
			task: "inspect the checks",
			domain: "demo",
			force: true,
			runId: "fake-probe",
			io: { log: () => {} },
		});
		expect(report.outcome).toBe("probed");
		expect(report.chosen).toBeNull();
		const probeLedger = loadLedger(join(cwd, ".pi", "harness", "runs", "fake-probe"));
		expect(probeLedger).toBeDefined();
		if (!probeLedger) throw new Error("fake-probe ledger missing");
		expect(countRP(probeLedger)).toEqual({ R: 1, P: 0 });
		const status = statusOfRun({ cwd, runId: "fake-probe", cfg: fakeCfg() });
		expect(status.ok).toBe(true);
		expect(status.text).toContain("probe-only run");
	}, 60_000);

	test("a foreign live lock refuses to start a run (no concurrent runs)", async () => {
		const cwd = makeCwd();
		mkdirSync(join(cwd, ".pi", "harness"), { recursive: true });
		writeFileSync(
			lockPath(cwd),
			JSON.stringify({ pid: process.pid, runId: "foreign-run", startedAt: new Date().toISOString(), host: "x" }),
		);
		await expect(
			runLoop({
				cfg: fakeCfg(),
				cwd,
				task: "should never start",
				domain: "demo",
				force: true,
				runId: "locked-out",
				io: { log: () => {}, confirmAdoption: async () => true },
			}),
		).rejects.toThrow(/in flight/);
	});

	test("a project without AGENTS.md adopts without the harness dirtying the tree", async () => {
		const cwd = makeCwd(); // README only, no AGENTS.md, clean tree
		expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
		// No `force`: the initial and the adoption-gate clean checks both run.
		const report = await runLoop({
			cfg: fakeCfg(),
			cwd,
			task: "keep the checks green while editing",
			domain: "demo",
			runId: "no-agents-starter",
			io: { log: () => {}, confirmAdoption: async () => true },
		});
		expect(report.outcome).toBe("adopted");
		// Adoption is what creates the always-on file, not the start of the run.
		expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
	});

	test("continuity pre-flight refuses a greenfield task on an existing project", async () => {
		const cwd = makeCwd();
		writeFileSync(
			join(cwd, "index.html"),
			"<!doctype html><html><head><title>Color Changing Heart</title></head><body></body></html>",
		);
		await expect(
			runLoop({
				cfg: fakeCfg(),
				cwd,
				task: "Turn index.html into an amazing interactive 3D solar system",
				domain: "demo",
				force: true,
				runId: "continuity-refused",
				io: { log: () => {}, confirmAdoption: async () => true },
			}),
		).rejects.toThrow(/continuity guard/);
		// refused before spending a model call or creating run state
		expect(existsSync(join(cwd, ".pi", "harness", "runs", "continuity-refused"))).toBe(false);
	});

	test("continuity pre-flight applies to probe too (it spends model calls)", async () => {
		const cwd = makeCwd();
		writeFileSync(
			join(cwd, "index.html"),
			"<!doctype html><html><head><title>Color Changing Heart</title></head></html>",
		);
		await expect(
			runReferenceProbes({
				cfg: fakeCfg(),
				cwd,
				task: "Turn index.html into an amazing interactive 3D solar system",
				domain: "demo",
				runId: "probe-continuity-refused",
				io: { log: () => {} },
			}),
		).rejects.toThrow(/continuity guard/);
		expect(existsSync(join(cwd, ".pi", "harness", "runs", "probe-continuity-refused"))).toBe(false);

		// ...unless the replacement is explicit
		const replaced = await runReferenceProbes({
			cfg: fakeCfg(),
			cwd,
			task: "Turn index.html into an amazing interactive 3D solar system",
			domain: "demo",
			replace: true,
			runId: "probe-continuity-replaced",
			io: { log: () => {} },
		});
		expect(replaced.outcome).toBe("probed");
	}, 60_000);
});

test("ledger identity math: R=4k, P=3k, selection/reflection uncounted", () => {
	const cfg = fakeCfg();
	const cwd = mkdtempSync(join(tmpdir(), "rsi-ledger-"));
	mkdirSync(join(cwd, ".pi", "harness", "runs", "id-test"), { recursive: true });
	for (const k of [1, 2, 4]) {
		const led = newLedger(`id-${k}`, "task", "demo", cfg);
		led.k = k;
		for (let i = 0; i < 4 * k; i++) addEntry(led, { kind: "rollout", label: `r${i}`, usd: 0, attempts: 1, wallMs: 0 });
		for (let i = 0; i < 3 * k; i++) addEntry(led, { kind: "session", label: `s${i}`, usd: 0, attempts: 1, wallMs: 0 });
		addEntry(led, { kind: "selection", label: "selection", usd: 0, attempts: 1, wallMs: 0 });
		addEntry(led, { kind: "reflection", label: "reflection", usd: 0, attempts: 1, wallMs: 0 });
		const id = assertIdentity(led);
		expect(id.ok).toBe(true);
		expect(id.expected).toEqual({ R: 4 * k, P: 3 * k });
		// break one entry: identity must report the mismatch, not crash
		addEntry(led, { kind: "rollout", label: "extra", usd: 0, attempts: 1, wallMs: 0 });
		expect(assertIdentity(led).ok).toBe(false);
	}
});
