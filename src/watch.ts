/**
 * Live run registry: an in-process view of the in-flight rsi run so
 * `/rsi-watch` can inspect it and `/rsi-stop` can interrupt it.
 *
 * The loop owns the entry (`beginRun` in `createRun`, `endRun` in `finish`);
 * commands only read the snapshot or abort the controller. Aborting SIGTERMs
 * the current child-`pi` call (see `probe.ts`) and the loop closes at the next
 * stage boundary with outcome `aborted_budget` (spend) or `aborted` (stop via
 * `/rsi-stop` or a STOP sentinel) — nothing is half-applied and the run dir
 * stays auditable like any other run.
 *
 * Cross-process fallback: the registry only sees runs of *this* pi process.
 * For runs started elsewhere (e.g. a headless `pi --print`), `/rsi-stop`
 * writes a `STOP` sentinel into the run dir — the loop checks it (and the
 * in-process signal) at every stage boundary — and `/rsi-watch` renders a
 * disk view from the run's ledger.
 */

import { join } from "node:path";
import { type LedgerFile, loadLedger, totalUsd } from "./ledger";
import { listRuns } from "./runs";
import { exists, writeText } from "./util";

export type RunKind = "loop" | "probe" | "adopt";

export interface ActiveRun {
	runId: string;
	runDir: string;
	task: string;
	domain: string;
	kind: RunKind;
	startedAt: number;
	/** Human-readable phase, e.g. "probe ref0", "propose ×2 (index 0)". */
	stage: string;
	/** Set by `/rsi-stop`; the loop unwinds at the next stage boundary. */
	stopped: boolean;
	/** Ring buffer of ledger notes, newest last. */
	notes: string[];
	controller: AbortController;
}

const MAX_LIVE_NOTES = 200;

let active: ActiveRun | undefined;

export function beginRun(info: {
	runId: string;
	runDir: string;
	task: string;
	domain: string;
	kind: RunKind;
}): ActiveRun {
	active = {
		...info,
		startedAt: Date.now(),
		stage: "starting",
		stopped: false,
		notes: [],
		controller: new AbortController(),
	};
	return active;
}

/** Clear the slot only if this run still owns it (a newer run may have taken it). */
export function endRun(runId: string): void {
	if (active?.runId === runId) {
		active = undefined;
	}
}

export function getActiveRun(): ActiveRun | undefined {
	return active;
}

export function setStage(run: ActiveRun, stage: string): void {
	if (active !== run) return;
	run.stage = stage;
}

export function pushLiveNote(run: ActiveRun, text: string): void {
	if (active !== run) return;
	run.notes.push(text);
	if (run.notes.length > MAX_LIVE_NOTES) run.notes.splice(0, run.notes.length - MAX_LIVE_NOTES);
}

/** Name of the cross-process interruption sentinel inside a run dir. */
export const STOP_FILE = "STOP";

/** Runs whose ledger still says `running`, newest first (disk view). */
function runningRunsOnDisk(cwd: string): Array<{ runId: string; runDir: string; ledger: LedgerFile }> {
	const found: Array<{ runId: string; runDir: string; ledger: LedgerFile }> = [];
	for (const { runId, runDir, ledger } of listRuns(cwd)) {
		if (ledger?.outcome === "running") found.push({ runId, runDir, ledger });
	}
	return found;
}

/** `/rsi-stop`: SIGTERM the current child call; the run closes at the next boundary.
 * Without an in-process run, falls back to the STOP sentinel for runs on disk. */
export function requestStop(cwd?: string): { ok: boolean; message: string } {
	if (!active) {
		const onDisk = cwd ? runningRunsOnDisk(cwd).find((r) => !exists(join(r.runDir, STOP_FILE))) : undefined;
		if (onDisk) {
			writeText(join(onDisk.runDir, STOP_FILE), new Date().toISOString());
			return {
				ok: true,
				message:
					`no run in this session, but run ${onDisk.runId} is still marked running on disk — ` +
					`wrote ${onDisk.runDir}/${STOP_FILE}; it closes with outcome "aborted" at its next stage boundary`,
			};
		}
		return { ok: false, message: "no rsi run in flight — nothing to stop" };
	}
	if (active.stopped) {
		return {
			ok: true,
			message: `stop already requested for run ${active.runId} (stage: ${active.stage}) — waiting for the current stage to unwind`,
		};
	}
	active.stopped = true;
	active.controller.abort();
	return {
		ok: true,
		message:
			`stopping run ${active.runId} during "${active.stage}" — the current child-` +
			`pi call is terminated and the run closes with outcome "aborted" (nothing adopted)`,
	};
}

function fmtElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const rest = s % 60;
	return h > 0 ? `${h}h${m}m` : m > 0 ? `${m}m${rest}s` : `${rest}s`;
}

/** `/rsi-watch`: snapshot of the in-flight run (or a disk view / hint when idle). */
export function renderWatch(cwd: string, tail = 12): { active: boolean; text: string } {
	const run = active;
	if (!run) {
		const onDisk = runningRunsOnDisk(cwd)[0];
		if (onDisk) {
			const { ledger, runDir } = onDisk;
			const stopped = exists(join(runDir, STOP_FILE));
			const lines = [
				`run ${ledger.runId} (${ledger.domain}) — ${ledger.task}  [disk view: started in another session]`,
				`usd: ${totalUsd(ledger).toFixed(4)}  outcome: ${ledger.outcome}${stopped ? "  (stop requested — unwinding)" : ""}`,
				stopped
					? "stop requested — the run closes as aborted at its next stage boundary"
					: `stage: unknown across sessions — /rsi-stop interrupts via ${runDir}/${STOP_FILE}`,
				"latest notes (from ledger):",
				...ledger.notes.slice(-tail).map((n) => `  - ${n}`),
			];
			return { active: true, text: lines.join("\n") };
		}
		return {
			active: false,
			text: "no rsi run in flight — /rsi-status shows the last run, /rsi starts one",
		};
	}
	const ledger = loadLedger(run.runDir);
	const spent = ledger ? totalUsd(ledger) : 0;
	const outcomeNote = ledger && ledger.outcome !== "running" ? `  outcome: ${ledger.outcome}` : "";
	const lines = [
		`run ${run.runId} (${run.kind}) — ${run.task}`,
		`domain: ${run.domain}  stage: ${run.stage}  elapsed: ${fmtElapsed(Date.now() - run.startedAt)}  usd: ${spent.toFixed(4)}${outcomeNote}`,
		run.stopped
			? "stop requested — unwinding the current stage; nothing will be adopted"
			: "in flight — /rsi-stop interrupts at the next stage boundary",
	];
	const notes = run.notes.slice(-tail);
	if (notes.length > 0) {
		lines.push("latest notes:");
		for (const n of notes) lines.push(`  - ${n}`);
	} else {
		lines.push("(no notes yet)");
	}
	return { active: true, text: lines.join("\n") };
}
