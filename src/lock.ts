/**
 * Cross-process run lock (README "Safety model").
 *
 * The in-process registry (`src/watch.ts`) can only see runs started by *this*
 * pi process. The lock is the on-disk backstop: `.pi/harness/run.lock` is held
 * for the lifetime of a run, so two sessions (or two `pi --print` invocations)
 * in the same repository cannot probe, prune or adopt concurrently.
 *
 * Staleness is fail-open by design: a lock whose pid is dead, or older than
 * `LOCK_STALE_MS`, is ignored so a crashed run never wedges the project. The
 * file is self-ignored via `.pi/harness/.gitignore` (see `ensureHarnessIgnored`).
 */

import { closeSync, openSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { ensureDir, readTextIf, rmrf } from "./util";

export interface RunLock {
	pid: number;
	runId: string;
	startedAt: string;
	host: string;
}

/** A lock older than this is considered abandoned (hung or killed run). */
export const LOCK_STALE_MS = 12 * 60 * 60 * 1000;

export function lockPath(cwd: string): string {
	return join(cwd, ".pi", "harness", "run.lock");
}

export function readRunLock(cwd: string): RunLock | undefined {
	const text = readTextIf(lockPath(cwd));
	if (!text) return undefined;
	try {
		const parsed = JSON.parse(text) as Partial<RunLock>;
		if (typeof parsed.pid !== "number" || typeof parsed.runId !== "string") return undefined;
		return {
			pid: parsed.pid,
			runId: parsed.runId,
			startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : new Date(0).toISOString(),
			host: typeof parsed.host === "string" ? parsed.host : "unknown",
		};
	} catch {
		return undefined;
	}
}

function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means the pid exists but belongs to another user — still alive.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The live holder of the lock, or undefined when free/stale/unreadable. */
export function heldRunLock(cwd: string): RunLock | undefined {
	const lock = readRunLock(cwd);
	if (!lock) return undefined;
	const age = Date.now() - Date.parse(lock.startedAt);
	if (!pidAlive(lock.pid) || !Number.isFinite(age) || age > LOCK_STALE_MS) return undefined;
	return lock;
}

export interface AcquiredLock {
	ok: true;
	release: () => void;
}

export interface RefusedLock {
	ok: false;
	holder: RunLock;
}

export class RunLockedError extends Error {
	readonly holder: RunLock;

	constructor(holder: RunLock, cwd: string = process.cwd()) {
		super(
			`another rsi run (${holder.runId}, pid ${holder.pid}) is in flight in this project — ` +
				`wait for it, /rsi stop it, or remove ${lockPath(cwd)} if it is stale`,
		);
		this.name = "RunLockedError";
		this.holder = holder;
	}
}

/**
 * Create the lock file *exclusively* (`wx` = O_CREAT|O_EXCL).
 * Returns false when the file already exists, which is the atomic half of
 * acquisition: the previous check-then-write let two processes both observe a
 * free lock and both believe they owned it.
 */
function createExclusive(path: string, body: string): boolean {
	try {
		const fd = openSync(path, "wx");
		try {
			writeSync(fd, body);
		} finally {
			closeSync(fd);
		}
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw err;
	}
}

/**
 * Acquire the run lock for `runId`. Refuses only when a *live* lock exists.
 *
 * `release()` is idempotent and only removes the lock if this process still
 * owns it (a later run may have taken it after a stale takeover).
 */
export function acquireRunLock(cwd: string, runId: string): AcquiredLock | RefusedLock {
	const path = lockPath(cwd);
	ensureDir(dirname(path));
	const body = JSON.stringify(
		{ pid: process.pid, runId, startedAt: new Date().toISOString(), host: hostname() },
		null,
		"\t",
	);

	// Fast path: exclusive create wins the race against any concurrent writer.
	if (!createExclusive(path, body)) {
		const holder = heldRunLock(cwd);
		if (holder) return { ok: false, holder };
		// The existing lock is stale or unreadable: take it over, then re-create
		// exclusively so two takeovers still cannot both win.
		rmrf(path);
		if (!createExclusive(path, body)) {
			const raced = heldRunLock(cwd);
			if (raced) return { ok: false, holder: raced };
			rmrf(path);
			if (!createExclusive(path, body)) {
				return {
					ok: false,
					holder: readRunLock(cwd) ?? { pid: 0, runId: "unknown", startedAt: new Date(0).toISOString(), host: "?" },
				};
			}
		}
	}

	let released = false;
	return {
		ok: true,
		release(): void {
			if (released) return;
			released = true;
			const current = readRunLock(cwd);
			if (current?.pid === process.pid && current.runId === runId) rmrf(path);
		},
	};
}
