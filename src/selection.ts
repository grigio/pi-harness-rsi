/**
 * Answer-free selection: anonymized deliverables, seeded
 * shuffle, and the trivial path at k=1 (`trivial_selection` parity — the stage
 * does not exist, so it is never asked for and never billed).
 *
 * The selector sees the *task* and the *deliverables*, never a rubric, a score
 * or which lever produced which candidate (P5).
 */

import { join } from "node:path";
import type { RsiConfig } from "./config";
import type { ProbeResult } from "./probe";
import { listFiles, readTextIf, seededShuffle, seedFromString, truncateMiddle, writeText } from "./util";

export interface Candidate {
	/** Anonymized id shown to the selector (`c0`, `c1`, …). */
	id: string;
	/** Real label used everywhere else (`final0`, …). */
	label: string;
	excerpt: string;
	deliverableCount: number;
}

export interface SelectionRecord {
	/** anonymized id → real label (kept out of the mission, stored on disk). */
	order: Array<{ id: string; label: string }>;
	chosenLabel: string | null;
	chosenId: string | null;
	why: string;
	seed: string;
	trivial: boolean;
}

/** At k=1 there is nothing to choose: the stage is skipped entirely. */
export function isTrivialSelection(k: number): boolean {
	return k <= 1;
}

export function selectionSeed(runId: string): number {
	return seedFromString(`selection:${runId}`);
}

/** Build the anonymized pool (deterministic for a given run id). */
export function buildPool(finals: readonly ProbeResult[], runDir: string, cfg: RsiConfig, seed: number): Candidate[] {
	const shuffled = seededShuffle(
		finals.map((f) => f.label),
		seed,
	);
	return shuffled.map((label, i) => ({
		id: `c${i}`,
		label,
		excerpt: deliverableExcerpt(runDir, label, cfg),
		deliverableCount: deliverableFiles(runDir, label).length,
	}));
}

export function renderCandidates(pool: readonly Candidate[]): string[] {
	return pool.map(
		(c) =>
			`### ${c.id}  (files: ${c.deliverableCount || "none"})\n` +
			`<!-- label withheld from this mission; identity lives in selection.json -->\n` +
			`${c.excerpt}`,
	);
}

export interface SelectionResult {
	record: SelectionRecord;
	/** Label chosen for adoption, or null when the stage failed open (first candidate). */
	chosenLabel: string;
}

export function saveSelection(runDir: string, record: SelectionRecord): void {
	writeText(join(runDir, "selection.json"), JSON.stringify(record, null, "\t"));
}

/** First candidate in the pool — the fail-open default when selection fails. */
export function fallbackChoice(pool: readonly Candidate[]): Candidate | undefined {
	return pool[0];
}

function deliverableFiles(runDir: string, label: string): string[] {
	const root = join(runDir, "evidence", "deliverables", label);
	try {
		return listFiles(root).slice(0, 6);
	} catch {
		return [];
	}
}

/**
 * Excerpt a candidate's deliverables, capped at the profile's excerpt budget.
 * Files are copied into `evidence/deliverables/<label>/` at probe time, so this
 * reads local files — never model context.
 */
function deliverableExcerpt(runDir: string, label: string, cfg: RsiConfig): string {
	const budget = cfg.budgets.deliverableExcerpt;
	const files = deliverableFiles(runDir, label);
	if (files.length === 0) {
		const digestText = readTextIf(join(runDir, "digests", `${label}.md`));
		return digestText ? `${truncateMiddle(digestText, budget)}` : "(no deliverable recorded for this candidate)";
	}
	const perFile = Math.max(200, Math.floor(budget / files.length));
	const parts: string[] = [];
	for (const rel of files) {
		const content = readTextIf(join(runDir, "evidence", "deliverables", label, rel));
		if (content === undefined) continue;
		parts.push(`file: ${rel}\n${truncateMiddle(content, perFile)}`);
	}
	return truncateMiddle(parts.join("\n\n"), budget);
}
