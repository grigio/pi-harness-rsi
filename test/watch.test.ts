import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config";
import { loadLedger, newLedger, saveLedger } from "../src/ledger";
import { type LoopOptions, runLoop } from "../src/loop";
import { getActiveRun, renderWatch, requestStop } from "../src/watch";

function makeCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "rsi-watch-"));
	writeFileSync(join(dir, "README.md"), "# demo project\n");
	return dir;
}

function fakeCfg(env: Record<string, string> = {}, overrides: Record<string, unknown> = {}) {
	return resolveConfig({ profile: "small", k: 1, ...overrides }, { PI_RSI_FAKE: "1", ...env } as NodeJS.ProcessEnv);
}

function opts(cwd: string, runId: string, extra: Partial<LoopOptions> = {}): LoopOptions {
	return {
		cfg: fakeCfg(),
		cwd,
		task: "keep the checks green while editing",
		domain: "demo",
		force: true,
		runId,
		io: { log: () => {}, confirmAdoption: async () => true },
		...extra,
	};
}

describe("live watch + stop (src/watch.ts)", () => {
	test("idle: /rsi-watch and /rsi-stop report there is nothing in flight", () => {
		expect(getActiveRun()).toBeUndefined();
		const snap = renderWatch(makeCwd());
		expect(snap.active).toBe(false);
		expect(snap.text).toContain("no rsi run in flight");
		const stop = requestStop();
		expect(stop.ok).toBe(false);
		expect(stop.message).toContain("nothing to stop");
	});

	test("an in-flight run is visible in /rsi-watch and /rsi-stop aborts it as `aborted`", async () => {
		const cwd = makeCwd();
		const pending = runLoop(opts(cwd, "fake-stop"));

		// createRun registers synchronously, before the first await
		const run = getActiveRun();
		expect(run?.runId).toBe("fake-stop");
		expect(run?.kind).toBe("loop");
		expect(run?.stopped).toBe(false);

		const snap = renderWatch(cwd);
		expect(snap.active).toBe(true);
		expect(snap.text).toContain("fake-stop");
		expect(snap.text).toContain("in flight");

		const stop = requestStop();
		expect(stop.ok).toBe(true);
		expect(stop.message).toContain("fake-stop");
		expect(getActiveRun()?.stopped).toBe(true);
		// a second stop is idempotent, not an error
		expect(requestStop().ok).toBe(true);

		const report = await pending;
		expect(report.outcome).toBe("aborted");
		expect(report.adopted).toBe(false);
		expect(report.notes.join("\n")).toContain("/rsi-stop");
		const ledger = loadLedger(join(cwd, ".pi", "harness", "runs", "fake-stop"));
		expect(ledger?.outcome).toBe("aborted"); // persisted, auditable
		expect(getActiveRun()).toBeUndefined(); // registry released
	}, 60_000);

	test("a pre-aborted external LoopOptions.signal ends the run before any stage", async () => {
		const cwd = makeCwd();
		const controller = new AbortController();
		controller.abort();
		const report = await runLoop(opts(cwd, "fake-signal", { signal: controller.signal }));
		expect(report.outcome).toBe("aborted");
		expect(report.identity.actual).toEqual({ R: 0, P: 0 }); // nothing ran past the check
		expect(getActiveRun()).toBeUndefined();
	}, 60_000);

	test("a STOP file in the run dir interrupts even from another session", async () => {
		const cwd = makeCwd();
		const runDir = join(cwd, ".pi", "harness", "runs", "fake-stopfile");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "STOP"), "");
		const report = await runLoop(opts(cwd, "fake-stopfile"));
		expect(report.outcome).toBe("aborted");
		expect(report.identity.actual).toEqual({ R: 0, P: 0 });
	}, 60_000);

	test("requestStop falls back to the STOP sentinel for a run started in another session", () => {
		const cwd = makeCwd();
		const runDir = join(cwd, ".pi", "harness", "runs", "fake-remote");
		mkdirSync(runDir, { recursive: true });
		const ledger = newLedger("fake-remote", "some task", "demo", fakeCfg());
		saveLedger(runDir, ledger); // outcome: "running"

		const stop = requestStop(cwd);
		expect(stop.ok).toBe(true);
		expect(stop.message).toContain("fake-remote");
		expect(existsSync(join(runDir, "STOP"))).toBe(true);
		// /rsi-watch renders a disk view of that still-running run
		const snap = renderWatch(cwd);
		expect(snap.active).toBe(true);
		expect(snap.text).toContain("disk view");
		expect(snap.text).toContain("stop requested");
		// a second stop does not rewrite the sentinel
		expect(requestStop(cwd).message).toContain("nothing to stop");
	});

	test("a full run releases the registry and the live tree is untouched after an abort", async () => {
		const cwd = makeCwd();
		const controller = new AbortController();
		const pending = runLoop(opts(cwd, "fake-clean", { signal: controller.signal }));
		controller.abort();
		const report = await pending;
		expect(report.outcome).toBe("aborted");
		expect(getActiveRun()).toBeUndefined();
		const after = renderWatch(cwd);
		expect(after.active).toBe(false);
		// nothing adopted: no live AGENTS.md was written by the aborted run
		let agents = "";
		try {
			agents = readFileSync(join(cwd, "AGENTS.md"), "utf8");
		} catch {
			// file absent is exactly what we want
		}
		expect(agents).not.toContain("procedure");
	}, 60_000);
});
