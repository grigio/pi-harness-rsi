/**
 * Run-directory retention (README “Settings”, `rsi.keepRuns`).
 *
 * `.pi/harness/runs/<id>/` holds the raw evidence a lesson can be repaired from
 * (session JSONL, digests, candidate surfaces), but it grows without bound.
 * `pruneRuns` keeps the newest `keepRuns` ledgers *and* everything still awaiting
 * adoption — it only ever deletes runs that are both old and decided.
 *
 * Pure disk work: no model calls, no mission changes, run ids sort
 * chronologically (`YYYYMMDD-HHMMSS-<slug>`), so "newest" is a string compare.
 * Unreadable ledgers are kept (fail closed — never delete evidence we cannot
 * account for).
 */

import { join } from "node:path";
import { loadLedger } from "./ledger";
import { listRunIds, runsDir } from "./runs";
import { rmrf } from "./util";

export interface PruneResult {
	/** Run ids removed from `.pi/harness/runs/` (newest-first order preserved). */
	removed: string[];
	/** Runs kept (in window, pending adoption, protected, or unreadable). */
	kept: number;
}

export function pruneRuns(cwd: string, opts: { keepRuns: number; protect?: readonly string[] }): PruneResult {
	const runsRoot = runsDir(cwd);
	const keep = Math.max(1, Math.floor(opts.keepRuns));
	const protect = new Set(opts.protect ?? []);

	// Newest first, top-level only (see src/runs.ts — recursive walks can miss runs).
	const names = listRunIds(cwd);
	if (names.length === 0) return { removed: [], kept: 0 };

	const removed: string[] = [];
	let kept = 0;
	for (const [i, name] of names.entries()) {
		const ledger = loadLedger(join(runsRoot, name));
		const pending = ledger !== undefined && ledger.outcome === "pending" && ledger.adopted !== true;
		if (i < keep || pending || protect.has(name) || ledger === undefined) {
			kept++;
			continue;
		}
		rmrf(join(runsRoot, name));
		removed.push(name);
	}
	return { removed, kept };
}
