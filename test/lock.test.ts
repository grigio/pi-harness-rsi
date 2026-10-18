import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRunLock, heldRunLock, lockPath, readRunLock } from "../src/lock";
import { ensureDir } from "../src/util";

function freshCwd(): string {
	return mkdtempSync(join(tmpdir(), "rsi-lock-"));
}

/** A pid that is guaranteed not to be live on this machine. */
const DEAD_PID = 2_147_483_646;

describe("cross-process run lock (src/lock.ts)", () => {
	test("acquire writes a readable lock metadata file; release removes it", () => {
		const cwd = freshCwd();
		const lock = acquireRunLock(cwd, "run-a");
		expect(lock.ok).toBe(true);

		const written = readRunLock(cwd);
		expect(written?.runId).toBe("run-a");
		expect(written?.pid).toBe(process.pid);
		expect(heldRunLock(cwd)?.runId).toBe("run-a");

		if (lock.ok) lock.release();
		expect(existsSync(lockPath(cwd))).toBe(false);
		expect(heldRunLock(cwd)).toBeUndefined();
	});

	test("a live lock refuses a second acquire and names the holder", () => {
		const cwd = freshCwd();
		const first = acquireRunLock(cwd, "run-a");
		const second = acquireRunLock(cwd, "run-b");
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.holder.runId).toBe("run-a");
		if (first.ok) first.release();
	});

	test("a stale lock (dead pid) is ignored and can be taken over", () => {
		const cwd = freshCwd();
		ensureDir(join(cwd, ".pi", "harness"));
		writeFileSync(
			lockPath(cwd),
			JSON.stringify({ pid: DEAD_PID, runId: "dead", startedAt: new Date(0).toISOString(), host: "x" }),
		);
		expect(heldRunLock(cwd)).toBeUndefined();
		const lock = acquireRunLock(cwd, "run-c");
		expect(lock.ok).toBe(true);
		if (lock.ok) lock.release();
	});

	test("a malformed lock file is treated as free (fail open)", () => {
		const cwd = freshCwd();
		mkdirSync(join(cwd, ".pi", "harness"), { recursive: true });
		writeFileSync(lockPath(cwd), "{ not json");
		expect(readRunLock(cwd)).toBeUndefined();
		expect(heldRunLock(cwd)).toBeUndefined();
	});

	test("release only removes the lock this process still owns", () => {
		const cwd = freshCwd();
		const lock = acquireRunLock(cwd, "run-a");
		expect(lock.ok).toBe(true);
		// Simulate a takeover by a later run before the first one released.
		writeFileSync(
			lockPath(cwd),
			JSON.stringify({ pid: process.pid, runId: "run-b", startedAt: new Date().toISOString(), host: "x" }),
		);
		if (lock.ok) lock.release();
		expect(readRunLock(cwd)?.runId).toBe("run-b");
	});
});
