/**
 * Guardrails (README “Safety model”): tripwires, forbidden globs, adoption gate,
 * working-tree hygiene. Everything here is fail-closed and returns verbatim
 * strings — validator messages go straight back to the editor as retry feedback.
 */

import { execSync } from "node:child_process";
import type { RsiConfig } from "./config";
import { matchesAnyGlob } from "./util";

/**
 * Grader-gaming tripwire. Scanned case-insensitively in file names *and* bodies
 * of every candidate surface and every library write. Deliberately conservative:
 * a false positive costs one fallback to the base surface, a false negative
 * costs the anti-Goodhart discipline.
 */
export const TRIPWIRE_MARKERS: readonly string[] = [
	"pass_rate",
	"passrate",
	"the grader expects",
	"the grader wants",
	"the grader is looking",
	"what the grader wants",
	"grader_gaming",
	"gaming the grader",
	"expected_score",
	"rubric_score",
	"the rubric expects",
	"delete the test file",
	"delete the failing test",
	"make the test pass without changing",
	"loosen the assertion",
	"weaken the assertion",
	"skip the failing test",
	"hidden test will",
];

/** Returns the marker that matched, or undefined. `subject` is used for error text. */
export function scanTripwire(subject: string, body: string): string | undefined {
	const haystack = `${subject}\n${body}`.toLowerCase();
	for (const marker of TRIPWIRE_MARKERS) {
		if (haystack.includes(marker)) return marker;
	}
	return undefined;
}

export function tripwireError(subject: string, marker: string): string {
	return `tripwire: forbidden marker "${marker}" in ${subject} — this surface edits behaviour, not graders; remove it and retry`;
}

/** Forbidden-path check against `rsi.forbiddenGlobs`. Returns the pattern that matched. */
export function forbiddenMatch(path: string, cfg: Pick<RsiConfig, "forbiddenGlobs">): string | undefined {
	return matchesAnyGlob(path, cfg.forbiddenGlobs);
}

export function forbiddenError(path: string, pattern: string): string {
	return `forbidden path: "${path}" matches immutable pattern "${pattern}" — outside the editable surface, remove it from the delta and retry`;
}

export class AdoptionGateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AdoptionGateError";
	}
}

/**
 * The extension proposes; the user adopts (P6). Throws unless adoption was
 * explicitly confirmed (or `rsi.confirmAdopt` is disabled by the user).
 */
export function assertAdoptionAllowed(cfg: Pick<RsiConfig, "confirmAdopt">, confirmed: boolean): void {
	if (!cfg.confirmAdopt) return;
	if (!confirmed) {
		throw new AdoptionGateError("adoption not confirmed — surface unchanged; run /rsi-adopt <label> to adopt a composed candidate");
	}
}

export interface DirtyReport {
	dirty: boolean;
	lines: string[];
}

/** `git status --porcelain` in the live working tree (never in a sandbox). */
export function workingTreeStatus(cwd: string): DirtyReport {
	try {
		const out = execSync("git status --porcelain", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		const lines = out.split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0);
		return { dirty: lines.length > 0, lines };
	} catch {
		// Not a git repository (or git missing): nothing to protect, nothing to leak.
		return { dirty: false, lines: [] };
	}
}

export class DirtyTreeError extends Error {
	constructor(lines: string[]) {
		super(
			`working tree has uncommitted changes (${lines.length} paths) — commit/stash first or pass --force so adoption cannot clobber local work`,
		);
		this.name = "DirtyTreeError";
	}
}
