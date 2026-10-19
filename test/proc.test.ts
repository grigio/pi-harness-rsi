import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { runProcess } from "../src/proc";

const IGNORE_SIGTERM = "process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});setInterval(()=>{},1000)";

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
