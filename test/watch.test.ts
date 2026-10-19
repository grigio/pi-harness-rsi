import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config";
import { loadLedger, newLedger, saveLedger } from "../src/ledger";
import { type LoopOptions, runLoop, runReferenceProbes, statusOfRun } from "../src/loop";
import { getActiveRun, renderWatch, requestStop, runIsLive, STOP_FILE, watchSnapshot } from "../src/watch";

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
	test("idle: /rsi watch and /rsi stop report there is nothing in flight", () => {
		expect(getActiveRun()).toBeUndefined();
		const snap = renderWatch(makeCwd());
		expect(snap.active).toBe(false);
		expect(snap.text).toContain("no rsi run in flight");
		const stop = requestStop();
		expect(stop.ok).toBe(false);
		expect(stop.message).toContain("nothing to stop");
		expect(watchSnapshot(makeCwd()).active).toBe(false);
	});

	test("watchSnapshot exposes the disk view (runId, notes, stopped) for a run from another session", () => {
		// Regression: `--follow` read the process-local registry, so following a
		// run started in another session (its whole purpose) said "no run in
		// flight". The snapshot is now the single source for every watch surface.
		const cwd = makeCwd();
		const runDir = join(cwd, ".pi", "harness", "runs", "fake-remote2");
		mkdirSync(runDir, { recursive: true });
		const ledger = newLedger("fake-remote2", "some task", "demo", fakeCfg());
		ledger.notes.push("probe ref0 finished");
		saveLedger(runDir, ledger);

		const snap = watchSnapshot(cwd);
		expect(snap.active).toBe(true);
		expect(snap.runId).toBe("fake-remote2");
		expect(snap.kind).toBe("disk");
		expect(snap.notes).toContain("probe ref0 finished");
		expect(snap.stopped).toBe(false);

		writeFileSync(join(runDir, STOP_FILE), "");
		expect(watchSnapshot(cwd).stopped).toBe(true);
	});

	test("an in-flight run is visible in /rsi watch and /rsi stop aborts it as `aborted`", async () => {
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
		expect(report.notes.join("\n")).toContain("/rsi stop");
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

	test("a probe-only run is `running` on disk while it lives (watch/stop can find it)", async () => {
		// Regression: probe runs wrote outcome "probed" at creation, so the disk
		// view — which filters on `running` — never saw a live probe and
		// `/rsi watch --follow` / `/rsi stop` from another session could not find it.
		const cwd = makeCwd();
		const pending = runReferenceProbes(opts(cwd, "fake-probe-vis"));
		const during = loadLedger(join(cwd, ".pi", "harness", "runs", "fake-probe-vis"));
		expect(during?.outcome).toBe("running");
		const report = await pending;
		expect(report.outcome).toBe("probed");
		expect(loadLedger(join(cwd, ".pi", "harness", "runs", "fake-probe-vis"))?.outcome).toBe("probed");
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
		// /rsi watch renders a disk view of that still-running run
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

describe("phantom runs: a `running` ledger whose owner process is gone", () => {
	/** A pid that is certainly not alive (pid 1 is init; use a huge odd value). */
	const DEAD_PID = 2 ** 30 + 7;

	test("runIsLive is false for a dead owner on this host, true otherwise", () => {
		const cwd = makeCwd();
		const runDir = join(cwd, ".pi", "harness", "runs", "phantom");
		mkdirSync(runDir, { recursive: true });
		const ledger = newLedger("phantom", "some task", "demo", fakeCfg());
		ledger.owner = { pid: DEAD_PID, host: hostname() };
		saveLedger(runDir, ledger);

		expect(runIsLive(ledger)).toBe(false);
		// another host is assumed alive (fail open — never drop a real remote run)
		expect(runIsLive({ ...ledger, owner: { pid: DEAD_PID, host: "some-other-host" } })).toBe(true);
		// no owner at all (an old ledger): fail open when there is nothing to check
		const noOwner = { ...ledger } as Partial<typeof ledger>;
		delete noOwner.owner;
		expect(runIsLive(noOwner as typeof ledger)).toBe(true);
		// a finished run is never "live", whatever its owner says
		expect(runIsLive({ ...ledger, outcome: "aborted" })).toBe(false);
	});

	test("an ownerless ledger falls back to the run lock (stale lock = phantom)", () => {
		const cwd = makeCwd();
		const runDir = join(cwd, ".pi", "harness", "runs", "legacy");
		mkdirSync(runDir, { recursive: true });
		const ledger = newLedger("legacy", "old task", "demo", fakeCfg());
		const noOwner = { ...ledger } as Partial<typeof ledger>;
		delete noOwner.owner;
		saveLedger(runDir, noOwner as typeof ledger);

		// No lock at all: a live run always holds one, so this is a phantom.
		expect(runIsLive(noOwner as typeof ledger, cwd)).toBe(false);
		expect(watchSnapshot(cwd).active).toBe(false);

		// A live lock naming this run means it is genuinely in flight.
		writeFileSync(
			join(cwd, ".pi", "harness", "run.lock"),
			JSON.stringify({ pid: process.pid, runId: "legacy", startedAt: new Date().toISOString(), host: hostname() }),
		);
		expect(runIsLive(noOwner as typeof ledger, cwd)).toBe(true);
		expect(watchSnapshot(cwd).active).toBe(true);
	});

	test("watch and status do not report a dead run as in flight, and stop writes nothing", () => {
		// Regression: a headless `pi --print "/rsi probe …"` exited while the
		// detached loop was still starting, leaving `outcome: running` forever.
		// `/rsi watch` then described a run that did not exist and `/rsi stop`
		// wrote a STOP sentinel no process would ever read.
		const cwd = makeCwd();
		const runDir = join(cwd, ".pi", "harness", "runs", "20260101-000000-phantom");
		mkdirSync(runDir, { recursive: true });
		const ledger = newLedger("20260101-000000-phantom", "some task", "demo", fakeCfg());
		ledger.owner = { pid: DEAD_PID, host: hostname() };
		saveLedger(runDir, ledger);

		expect(watchSnapshot(cwd).active).toBe(false);
		const stop = requestStop(cwd);
		expect(stop.ok).toBe(false);
		expect(existsSync(join(runDir, STOP_FILE))).toBe(false);

		const status = statusOfRun({ cwd, cfg: fakeCfg(), runId: "20260101-000000-phantom" });
		expect(status.ok).toBe(true);
		expect(status.text).toContain("owner process is gone");
	});
});
