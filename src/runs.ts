/**
 * Run-directory discovery (single source of truth).
 *
 * Every caller that needs "which runs exist / newest first" goes through here:
 * `loop.latestRunDir`, `watch.runningRunsOnDisk`, `retention.pruneRuns` and
 * `index.ts` completions. Reading only top-level entries is deliberate — a run
 * dir accumulates evidence files (session JSONL, deliverables, digests), and a
 * recursive walk with a file cap can silently miss *later* runs. Top-level
 * `readdir` is O(runs), not O(evidence).
 *
 * Run ids sort chronologically (`YYYYMMDD-HHMMSS-<slug>`), so "newest" is a
 * string compare. Unreadable/missing ledgers are reported as `ledger:
 * undefined` (callers fail closed — never deleted/overwritten).
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { type LedgerFile, loadLedger } from "./ledger";

/** `.pi/harness/runs` inside a project root. */
export function runsDir(root: string): string {
	return join(root, ".pi", "harness", "runs");
}

/** Top-level run ids, newest first. No filesystem recursion. */
export function listRunIds(root: string): string[] {
	try {
		return readdirSync(runsDir(root), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort()
			.reverse();
	} catch {
		return [];
	}
}

export interface RunRef {
	runId: string;
	runDir: string;
	/** `undefined` when the ledger is missing or unreadable (fail closed). */
	ledger: LedgerFile | undefined;
}

/** Run ids + their ledgers, newest first. */
export function listRuns(root: string): RunRef[] {
	const base = runsDir(root);
	return listRunIds(root).map((runId) => {
		const runDir = join(base, runId);
		return { runId, runDir, ledger: loadLedger(runDir) };
	});
}

/** Newest run that has a readable ledger, or undefined. */
export function latestRunId(
	root: string,
	opts: { predicate?: (ledger: LedgerFile) => boolean } = {},
): string | undefined {
	for (const ref of listRuns(root)) {
		if (!ref.ledger) continue;
		if (opts.predicate && !opts.predicate(ref.ledger)) continue;
		return ref.runId;
	}
	return undefined;
}
