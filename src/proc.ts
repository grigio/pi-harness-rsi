/**
 * Child-process primitives shared by the probe runner and the verifier.
 *
 * Both are long-running and must be interruptible: a `pi` child or a verifier
 * blocked in `execSync` freezes the whole extension event loop (the footer
 * spinner stops, `/rsi watch --follow` stops polling and `/rsi stop` cannot even
 * deliver its abort). Everything here is async, killed as a process *tree* and
 * capture-bounded.
 */

import { type ChildProcess, spawn } from "node:child_process";

/**
 * SIGTERM the whole child process group — `child.kill()` only signals the
 * direct child, so a sandbox `pi` (or a verifier) that spawned bash/tool
 * grandchildren would survive a timeout or `/rsi stop`. `detached: true`
 * (POSIX) makes the child a group leader, so `-pid` reaches the tree; the
 * fallback covers platforms that reject negative pids.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid === undefined) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// already gone
		}
	}
}

/**
 * Cap on captured child output. Only the tail is ever used (error messages),
 * and an unbounded accumulator let a chatty child OOM the orchestrator.
 */
export const MAX_CAPTURE_CHARS = 1_000_000;

export function capture(acc: string, chunk: string): string {
	if (acc.length + chunk.length <= MAX_CAPTURE_CHARS) return acc + chunk;
	// Keep the newest text: error tails are what get reported.
	return (acc + chunk).slice(-MAX_CAPTURE_CHARS);
}

export interface ProcessOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	/** Hard wall-clock cap; the tree is SIGTERMed, then SIGKILLed after the grace period. */
	timeoutMs: number;
	signal?: AbortSignal;
	/** How long to wait after SIGTERM before SIGKILLing the tree (default 5 s). */
	killGraceMs?: number;
}

export interface ProcessResult {
	code: number;
	stdout: string;
	stderr: string;
	wallMs: number;
	killed: boolean;
	timedOut: boolean;
	error?: string;
}

/** Run a process to completion under a timeout and an optional abort signal. */
export function runProcess(bin: string, args: string[], opts: ProcessOptions): Promise<ProcessResult> {
	const started = Date.now();
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let killed = false;
		let timedOut = false;
		let settled = false;

		const child = spawn(bin, args, {
			cwd: opts.cwd,
			env: opts.env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});

		let killTimer: ReturnType<typeof setTimeout> | undefined;
		// SIGTERM first, then SIGKILL if the tree ignores it. Both the wall-clock
		// timeout and `/rsi stop` go through this: an abort used to send only
		// SIGTERM, so a child (or a grandchild holding its pipes) that trapped or
		// ignored SIGTERM kept the promise pending until the stage timeout — which
		// is exactly the "stop does nothing" report.
		const terminate = (): void => {
			killed = true;
			killTree(child, "SIGTERM");
			if (!killTimer) killTimer = setTimeout(() => killTree(child, "SIGKILL"), opts.killGraceMs ?? 5_000);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			terminate();
		}, opts.timeoutMs);

		const onAbort = (): void => terminate();
		// The signal may already be aborted by the time we spawn: an
		// `addEventListener` after the fact never fires.
		if (opts.signal?.aborted) onAbort();
		else opts.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout = capture(stdout, chunk);
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr = capture(stderr, chunk);
		});

		const finish = (code: number, error?: string): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			killTimer = undefined;
			opts.signal?.removeEventListener("abort", onAbort);
			resolve({ code, stdout, stderr, wallMs: Date.now() - started, killed, timedOut, error });
		};

		child.on("error", (err) => finish(127, err.message));
		child.on("close", (code) => finish(code ?? (killed ? 124 : 1)));
	});
}
