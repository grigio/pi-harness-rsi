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

/**
 * Skill-script supply-chain scan (README “Safety model”). A `.pi/skills/<name>/scripts/**`
 * file is *executable capability*: it is mounted into every probe sandbox from
 * then on. Candidates are scanned for hostile shell before they can be probed or
 * adopted — fail-closed like the tripwires (review before you mount).
 *
 * Deliberately narrow: plain `curl` to a local health endpoint is fine; what is
 * forbidden is fetch-and-execute, credential access, exfil and persistence.
 */
export interface ScriptMarker {
	id: string;
	re: RegExp;
}

export const SCRIPT_MARKERS: readonly ScriptMarker[] = [
	{ id: "pipe-to-shell", re: /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|fi)?sh\b/ },
	{ id: "base64-pipe-exec", re: /base64\s+(?:--)?decode\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|fi)?sh\b/ },
	{ id: "eval-network", re: /\beval\b[^\n]*\b(?:curl|wget|base64)\b/ },
	{ id: "sudo", re: /\bsudo\b/ },
	{ id: "ssh-secrets", re: /\.ssh\b|id_rsa\b|id_ed25519\b/ },
	{
		id: "credential-store",
		re: /\.aws\/|\.gnupg\/|\.kube\/|\.docker\/config\.json|\.config\/gcloud|\.netrc\b|password-store/,
	},
	{ id: "agent-config-access", re: /\.config\/pi\b|\.pi\/agent\b|\.claude\b|\.codex\/|\.continue\/|\.cursor\// },
	{ id: "reverse-shell", re: /\/dev\/tcp\/[^\s]+\s+0>&1|\bncat\b[^|\n]*\s-e\s|\bnc\b[^|\n]*\s-e\s/ },
	{ id: "rm-escape", re: /rm\s+-[a-zA-Z]*[rRf][a-zA-Z]*\s+(?:--no-preserve-root\s+)?["']?(?:\/|~|\$HOME|\.\.\/)/ },
	{ id: "env-exfil", re: /\b(?:curl|wget)\b[^|\n]*\$\(\s*(?:env|printenv)\s*\)/ },
	{ id: "history-wipe", re: /\bhistory\s+-c\b|>\s*["']?~?\/?\.bash_history/ },
];

/** All marker ids matching a script body (empty array = clean). */
export function scanScriptBody(path: string, body: string): string[] {
	const hits: string[] = [];
	for (const marker of SCRIPT_MARKERS) {
		if (marker.re.test(`${path}\n${body}`)) hits.push(marker.id);
	}
	return hits;
}

export function scriptScanError(path: string, id: string): string {
	return `script scan: forbidden pattern "${id}" in ${path} — skill scripts run in every probe sandbox; remove the pattern and retry`;
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
		throw new AdoptionGateError(
			"adoption not confirmed — surface unchanged; run /rsi adopt <label> to adopt a composed candidate",
		);
	}
}

export interface DirtyReport {
	dirty: boolean;
	lines: string[];
	/** Set when `git status` itself failed for a reason other than "not a repo". */
	error?: string;
}

/**
 * Harness-managed paths that must never count as "dirty": the extension writes
 * `.pi/harness/.gitignore` itself on every run, and `runs/`/`worktrees/`/the lock
 * are ephemeral. Without this filter the very first run in a fresh project would
 * create a file and then refuse itself for having a dirty tree.
 */
const HARNESS_EPHEMERAL = [".pi/harness/.gitignore", ".pi/harness/run.lock"];
const HARNESS_EPHEMERAL_PREFIXES = [".pi/harness/runs/", ".pi/harness/worktrees/"];

function isHarnessEphemeral(path: string): boolean {
	return HARNESS_EPHEMERAL.includes(path) || HARNESS_EPHEMERAL_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** `git status --porcelain` in the live working tree (never in a sandbox). */
export function workingTreeStatus(cwd: string): DirtyReport {
	try {
		// `--untracked-files=all` avoids git collapsing a directory to one `?? dir/`
		// line, so the ephemeral filter below can see the individual paths.
		const out = execSync("git status --porcelain --untracked-files=all", {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const lines = out
			.split("\n")
			.map((l) => l.trimEnd())
			.filter((l) => l.length > 0)
			.filter((l) => {
				const raw = l.slice(3);
				const path = raw.includes(" -> ") ? (raw.split(" -> ").pop() ?? raw) : raw;
				return !isHarnessEphemeral(path.replace(/^"|"$/g, ""));
			});
		return { dirty: lines.length > 0, lines };
	} catch (err) {
		// Distinguish "this is not a git repository" (nothing to protect, nothing
		// to leak) from "git itself failed" (index.lock, transient I/O, git
		// missing). Treating the second as clean was fail-*open*: adoption could
		// clobber uncommitted work because the safety check could not run.
		const e = err as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
		const text = `${e.stderr ?? ""}\n${e.stdout ?? ""}\n${e.message ?? ""}`;
		if (/not a git repository|not a git work tree/i.test(String(text))) return { dirty: false, lines: [] };
		const message = String(e.stderr ?? "").trim() || e.message || "git status failed";
		return { dirty: true, lines: [`<git status failed: ${message.slice(0, 200)}>`], error: message };
	}
}

export class DirtyTreeError extends Error {
	constructor(report: DirtyReport | string[]) {
		const report2: DirtyReport = Array.isArray(report) ? { dirty: true, lines: report } : report;
		const detail = report2.error
			? `git status could not run (${report2.error.slice(0, 160)}) — refusing to treat the tree as clean`
			: `working tree has uncommitted changes (${report2.lines.length} paths) — commit/stash first or pass --force so adoption cannot clobber local work`;
		super(detail);
		this.name = "DirtyTreeError";
	}
}
