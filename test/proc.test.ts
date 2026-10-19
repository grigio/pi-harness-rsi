import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { resolveConfig } from "../src/config";
import { spawnPi } from "../src/probe";
import { runProcess } from "../src/proc";

const IGNORE_SIGTERM = "process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});setInterval(()=>{},1000)";

const cfg = resolveConfig({ profile: "small", stageTimeoutMs: 30_000 }, {} as NodeJS.ProcessEnv);

describe("runProcess abort kills the tree, not just SIGTERMs it", () => {
	test("an abort settles even when the child ignores SIGTERM (SIGKILL escalation)", async () => {
		const controller = new AbortController();
		const started = Date.now();
		const pending = runProcess(process.execPath, ["-e", IGNORE_SIGTERM], {
			cwd: tmpdir(),
			timeoutMs: 30_000,
			signal: controller.signal,
			killGraceMs: 100,
		});
		setTimeout(() => controller.abort(), 50);
		const result = await pending;
		const elapsed = Date.now() - started;
		expect(result.killed).toBe(true);
		expect(result.timedOut).toBe(false);
		// Well under the 30s wall-clock timeout: proves the abort itself forced the kill.
		expect(elapsed).toBeLessThan(5_000);
	}, 15_000);

	test("a child that exits normally is not marked killed", async () => {
		const result = await runProcess(process.execPath, ["-e", "process.exit(0)"], {
			cwd: tmpdir(),
			timeoutMs: 10_000,
		});
		expect(result.code).toBe(0);
		expect(result.killed).toBe(false);
	}, 15_000);
});

describe("spawnPi abort uses the same SIGKILL escalation as the verifier", () => {
	const previous = process.env.PI_RSI_PI_BIN;

	test("a rollouts child that ignores SIGTERM is still killed on /rsi stop", async () => {
		// Regression: spawnPi had its own spawn loop and its abort path sent only
		// SIGTERM (no escalation), so a trapping child kept the run alive until
		// stageTimeoutMs (10 min by default) — `/rsi stop` looked like a no-op.
		process.env.PI_RSI_PI_BIN = process.execPath;
		try {
			const controller = new AbortController();
			const started = Date.now();
			const pending = spawnPi(["-e", IGNORE_SIGTERM], {
				cwd: tmpdir(),
				cfg,
				signal: controller.signal,
				killGraceMs: 100,
			});
			setTimeout(() => controller.abort(), 50);
			const result = await pending;
			expect(result.killed).toBe(true);
			expect(result.error).toContain("aborted");
			// Well under the 30s stage timeout: the abort itself forced the kill.
			expect(Date.now() - started).toBeLessThan(5_000);
		} finally {
			if (previous === undefined) delete process.env.PI_RSI_PI_BIN;
			else process.env.PI_RSI_PI_BIN = previous;
		}
	}, 15_000);
});
