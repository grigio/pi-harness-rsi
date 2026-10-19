/**
 * Ledger (README “Safety model”): Harness² budget identity `R = 4k` rollouts,
 * `P = 3k` improvement sessions, USD accounting, fallback counters and the
 * diversity metric — everything `/rsi status` renders.
 *
 * Selection and reflection are recorded *outside* the identity (parity with
 * Harness² `ledger.py`), so they carry kind `selection` / `reflection` and are
 * excluded from R/P counting.
 */

import { hostname } from "node:os";
import { join } from "node:path";
import type { RsiConfig } from "./config";
import { formatMinutes } from "./config";
import { ensureDir, exists, readTextIf, writeText } from "./util";

export type LedgerKind = "rollout" | "session" | "selection" | "reflection";

export interface LedgerEntry {
	kind: LedgerKind;
	label: string;
	usd: number;
	attempts: number;
	wallMs?: number;
	ts: string;
}

export interface LedgerFile {
	runId: string;
	task: string;
	domain: string;
	k: number;
	mode: string;
	profile: string;
	entries: LedgerEntry[];
	counters: {
		/** Proposals/compositions that fell back to the base surface after a retry. */
		keptBase: number;
		/** Validation/guard failures (subset of keptBase decisions, counted separately). */
		fellBack: number;
		/** Tripwire / forbidden-glob rejections. */
		tripwire: number;
		/** Editor child-runs that failed outright (non-zero exit, unparsable reply). */
		editorErrors: number;
	};
	/** Assembled char size per stage (`propose`, `compose`, `reflect`, `select`). */
	budgetsUsed: Record<string, number>;
	/** Mean line-Jaccard across composed candidates (mode-collapse detector). */
	diversity: number | null;
	/**
	 * Wall-clock start of the run (ISO). The status view uses it to report elapsed
	 * time next to USD, both as budgets. Optional: old ledgers predate it.
	 */
	startedAt?: string;
	outcome:
		| "running"
		| "probed"
		| "adopted"
		| "pending"
		| "no_change"
		| "fell_back"
		| "aborted_budget"
		| "aborted_timeout"
		| "aborted"
		| "error";
	/**
	 * The pid (and host) of the process that owns the run. A ledger left at
	 * `outcome: "running"` by a process that died — the exact case of a headless
	 * `pi --print` whose parent exits mid-run — can then be told apart from a run
	 * that is genuinely still alive. Absent on old ledgers (treated as unknown).
	 */
	owner?: { pid: number; host: string };
	chosen: string | null;
	adopted: boolean;
	notes: string[];
	updatedAt: string;
}

export function ledgerPath(runDir: string): string {
	return join(runDir, "ledger.json");
}

export function newLedger(
	runId: string,
	task: string,
	domain: string,
	cfg: Pick<RsiConfig, "k" | "mode" | "profile">,
): LedgerFile {
	return {
		runId,
		task,
		domain,
		k: cfg.k,
		mode: cfg.mode,
		profile: cfg.profile,
		entries: [],
		counters: { keptBase: 0, fellBack: 0, tripwire: 0, editorErrors: 0 },
		budgetsUsed: {},
		diversity: null,
		outcome: "running",
		startedAt: new Date().toISOString(),
		owner: { pid: process.pid, host: hostname() },
		chosen: null,
		adopted: false,
		notes: [],
		updatedAt: new Date().toISOString(),
	};
}

export function loadLedger(runDir: string): LedgerFile | undefined {
	const path = ledgerPath(runDir);
	if (!exists(path)) return undefined;
	try {
		return JSON.parse(readTextIf(path) ?? "") as LedgerFile;
	} catch {
		return undefined;
	}
}

export function saveLedger(runDir: string, ledger: LedgerFile): void {
	ledger.updatedAt = new Date().toISOString();
	ensureDir(runDir);
	writeText(ledgerPath(runDir), JSON.stringify(ledger, null, "\t"));
}

export function addEntry(ledger: LedgerFile, entry: Omit<LedgerEntry, "ts">): void {
	ledger.entries.push({ ...entry, ts: new Date().toISOString() });
}

export interface IdentityReport {
	ok: boolean;
	expected: { R: number; P: number };
	actual: { R: number; P: number };
	problems: string[];
}

/** Counted kinds: `rollout` → R, `session` → P. */
export function countRP(ledger: LedgerFile): { R: number; P: number } {
	let R = 0;
	let P = 0;
	for (const entry of ledger.entries) {
		if (entry.kind === "rollout") R++;
		else if (entry.kind === "session") P++;
	}
	return { R, P };
}

/**
 * `R = 4k` (k references + 2k candidate probes + k composed probes),
 * `P = 3k` (2k proposes + k composes). Selection/reflection are uncounted.
 */
export function assertIdentity(ledger: LedgerFile): IdentityReport {
	const expected = { R: 4 * ledger.k, P: 3 * ledger.k };
	const actual = countRP(ledger);
	const problems: string[] = [];
	if (actual.R !== expected.R) problems.push(`R=${actual.R}, expected 4k=${expected.R}`);
	if (actual.P !== expected.P) problems.push(`P=${actual.P}, expected 3k=${expected.P}`);
	return { ok: problems.length === 0, expected, actual, problems };
}

export function totalUsd(ledger: LedgerFile): number {
	return ledger.entries.reduce((sum, e) => sum + (Number.isFinite(e.usd) ? e.usd : 0), 0);
}

/** Wall-clock milliseconds since the run started, or 0 when the ledger predates `startedAt`. */
export function elapsedMs(ledger: LedgerFile, now: number): number {
	const start = Date.parse(ledger.startedAt ?? ledger.entries[0]?.ts ?? "");
	if (!Number.isFinite(start)) return 0;
	return Math.max(0, now - start);
}

/** `192000` → `3m12s`, `7400` → `7s` — the elapsed half of the time budget line. */
export function formatElapsed(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const seconds = totalSeconds % 60;
	const minutes = Math.floor(totalSeconds / 60);
	if (minutes === 0) return `${seconds}s`;
	return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

export interface StatusInput {
	ledger: LedgerFile;
	cfg: RsiConfig;
	/** Mission text sizes for the stages that ran. */
	budgetsUsed?: Record<string, number>;
	/** Injectable clock (tests); defaults to `Date.now()`. */
	now?: number;
}

/** Multi-line `/rsi status` report. Pure — the command only prints it. */
export function renderStatus(input: StatusInput): string {
	const { ledger, cfg } = input;
	const identity = assertIdentity(ledger);
	const spent = totalUsd(ledger);
	const lines: string[] = [];

	lines.push(`run ${ledger.runId}  task: ${ledger.task}`);
	lines.push(`profile=${ledger.profile} k=${ledger.k} mode=${ledger.mode} domain=${ledger.domain}`);
	if (ledger.outcome === "probed") {
		lines.push(`ledger: R ${identity.actual.R} rollouts (probe-only run — R=4k/P=3k identity does not apply)`);
	} else {
		lines.push(
			`ledger: R ${identity.actual.R}/${identity.expected.R}  P ${identity.actual.P}/${identity.expected.P}` +
				(identity.ok ? "  identity OK" : `  IDENTITY MISMATCH (${identity.problems.join("; ")})`),
		);
	}
	const usdNote = cfg.maxUsdSource === "env" ? "env" : "setting";
	lines.push(`usd: ${spent.toFixed(4)} / max ${cfg.maxUsd} (${usdNote})`);
	lines.push(`time: ${formatElapsed(elapsedMs(ledger, input.now ?? Date.now()))} / max ${formatMinutes(cfg.maxRunMs)}`);
	lines.push(
		`kept_base: ${ledger.counters.keptBase}  fell_back: ${ledger.counters.fellBack}  ` +
			`tripwire: ${ledger.counters.tripwire}  editor_errors: ${ledger.counters.editorErrors}`,
	);
	lines.push(`diversity: ${diversityText(ledger.diversity, ledger.k)}`);
	lines.push(
		`outcome: ${ledger.outcome}${ledger.chosen ? `  chosen: ${ledger.chosen}` : ""}${ledger.adopted ? "  adopted" : ""}`,
	);

	const used = { ...ledger.budgetsUsed, ...(input.budgetsUsed ?? {}) };
	const rows = budgetRows(used, cfg);
	if (rows.length > 0) lines.push(`budgets: ${rows.join("  ")}`);

	if (ledger.notes.length > 0) {
		lines.push("notes:");
		for (const note of ledger.notes.slice(-6)) lines.push(`  - ${note}`);
	}
	return lines.join("\n");
}

export function budgetRows(used: Record<string, number>, cfg: RsiConfig): string[] {
	const map: Array<[string, number]> = [
		["propose", cfg.budgets.proposeMission],
		["compose", cfg.budgets.composeMission],
		["select", cfg.budgets.selectMission],
		["reflect", cfg.budgets.reflectMission],
	];
	return map
		.filter(([stage]) => used[stage] !== undefined)
		.map(([stage, budget]) => `${stage} ${used[stage]}/${budget}`);
}

export function diversityText(diversity: number | null, k: number): string {
	if (k <= 1) return "n/a (k=1 — selection stage skipped)";
	if (diversity === null) return "not measured";
	const flag = diversity >= 0.9 ? "  ⚠ mode collapse (line-Jaccard ≥ 0.9)" : "";
	return `${diversity.toFixed(3)} mean line-Jaccard${flag}`;
}

/** Notes are capped prose — never let the editor's free text grow the file. */
export function pushNote(ledger: LedgerFile, note: string, max = 400): void {
	const clean = note.replace(/\s+/g, " ").trim().slice(0, max);
	if (clean.length === 0) return;
	ledger.notes.push(clean);
	if (ledger.notes.length > 50) ledger.notes = ledger.notes.slice(-50);
}
