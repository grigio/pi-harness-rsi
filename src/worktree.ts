/**
 * Sandbox lifecycle: one isolated working tree per rollout,
 * matched conditions across arms (only the surface files differ), cleanup in
 * `finally`.
 *
 * Two kinds:
 *  - `worktree` — a detached git worktree of the host repo (preferred);
 *  - `copy`     — for non-git projects: a plain tree copy with `.git`,
 *                 `node_modules` and `.pi/harness` excluded.
 *
 * Nothing here ever touches the user's live working tree; `--approve` is only
 * ever passed to children whose cwd is a sandbox created here.
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RsiConfig } from "./config";
import { runProcess } from "./proc";
import { type Surface, writeSurface } from "./surface";
import { copyDir, ensureDir, hash12, readTextIf, rmrf, writeText } from "./util";

export type SandboxKind = "worktree" | "copy";

export interface Sandbox {
	readonly path: string;
	readonly kind: SandboxKind;
	/** Stage a surface into the sandbox (prunes surface files the candidate dropped). */
	stage(surface: Surface): void;
	/** `+A −D` numstat against HEAD, when the sandbox is a git worktree. */
	diffStat(): Promise<string | undefined>;
	/** Idempotent removal (called from `finally`). */
	cleanup(): void;
}

export function isGitRepo(root: string): boolean {
	try {
		return (
			execSync("git rev-parse --is-inside-work-tree", {
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim() === "true"
		);
	} catch {
		return false;
	}
}

/**
 * Keep the harness directory out of `git status` in the host repo.
 * Writes `.pi/harness/.gitignore` (idempotent, never touches `.git/info/exclude`).
 */
export function ensureHarnessIgnored(repoRoot: string): void {
	const dir = join(repoRoot, ".pi", "harness");
	ensureDir(dir);
	const gitignore = join(dir, ".gitignore");
	if (readTextIf(gitignore) !== "worktrees/\nruns/\nrun.lock\n") writeText(gitignore, "worktrees/\nruns/\nrun.lock\n");
}

/** Resolved sandbox root inside the repo (relative settings resolve from the repo). */
export function worktreeRootPath(repoRoot: string, cfg: Pick<RsiConfig, "worktreeRoot">): string {
	return cfg.worktreeRoot.startsWith("/") ? cfg.worktreeRoot : join(repoRoot, cfg.worktreeRoot);
}

/**
 * Short, stable token identifying a run inside a sandbox directory name. The
 * token leads the name so `cleanupSandboxes({ protect: [runId] })` can skip a
 * live run's sandboxes without having to reverse a hash that also mixed in the
 * label.
 */
export function runToken(runId: string): string {
	return hash12(runId).slice(0, 6);
}

/** Directory name for one rollout: unique per run *and* per label. */
export function sandboxId(runId: string, label: string): string {
	return `${runToken(runId)}-${hash12(`${runId}:${label}`).slice(0, 8)}-${label}`;
}

export interface PrepareOptions {
	/** Unique per rollout — the sandbox lives at `<worktreeRoot>/<id>`. */
	id: string;
	/**
	 * Copy the live tree instead of checking out HEAD. Required whenever the
	 * live tree may differ from HEAD (dirty tree with `--force`, or a non-git
	 * project), so the solver probes exactly the surface that was snapshotted.
	 */
	forceCopy?: boolean;
	/** Non-git fallback: copy this tree instead of a worktree checkout. */
	copySource?: string;
}

const COPY_EXCLUDES = [".git", "node_modules", "dist", "build", ".cache", ".turbo", ".next", "target", ".pi/harness"];

/** Create (and stage nothing yet — call `stage()` for that) an isolated sandbox. */
export function prepareSandbox(repoRoot: string, cfg: RsiConfig, opts: PrepareOptions): Sandbox {
	const root = worktreeRootPath(repoRoot, cfg);
	ensureHarnessIgnored(repoRoot);
	ensureDir(root);
	const path = join(root, opts.id);
	rmrf(path);

	if (!opts.forceCopy && isGitRepo(repoRoot)) {
		try {
			execFileSync("git", ["worktree", "add", "--detach", path, "HEAD"], {
				cwd: repoRoot,
				stdio: ["ignore", "pipe", "pipe"],
			});
			return makeWorktreeSandbox(repoRoot, path);
		} catch (err) {
			// Fall through to a copy sandbox (e.g. bare repos, worktree limits).
			void err;
		}
	}

	const source = opts.copySource ?? repoRoot;
	ensureDir(path);
	copyDir(source, path, { excludeDirs: COPY_EXCLUDES, maxFiles: 20000 });
	return makeCopySandbox(path);
}

function makeWorktreeSandbox(repoRoot: string, path: string): Sandbox {
	let cleaned = false;
	return {
		path,
		kind: "worktree",
		stage(surface: Surface): void {
			writeSurface(path, surface, { prune: true });
		},
		diffStat(): Promise<string | undefined> {
			return (async (): Promise<string | undefined> => {
				try {
					const add = await runProcess("git", ["add", "-A"], { cwd: path, timeoutMs: 60_000 });
					if (add.code !== 0) return undefined;
					const diff = await runProcess("git", ["diff", "--cached", "--numstat", "HEAD"], {
						cwd: path,
						timeoutMs: 60_000,
					});
					if (diff.code !== 0) return undefined;
					let added = 0;
					let removed = 0;
					for (const line of diff.stdout.split("\n")) {
						const m = line.match(/^(\d+)\t(\d+)\t/);
						if (!m) continue;
						added += Number(m[1]);
						removed += Number(m[2]);
					}
					return `+${added} −${removed}`;
				} catch {
					return undefined;
				}
			})();
		},
		cleanup(): void {
			if (cleaned) return;
			cleaned = true;
			try {
				execFileSync("git", ["worktree", "remove", "--force", path], {
					cwd: repoRoot,
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch {
				rmrf(path);
			}
			try {
				execFileSync("git", ["worktree", "prune"], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
			} catch {
				// prune is best-effort
			}
		},
	};
}

function makeCopySandbox(path: string): Sandbox {
	let cleaned = false;
	return {
		path,
		kind: "copy",
		stage(surface: Surface): void {
			writeSurface(path, surface, { prune: true });
		},
		diffStat(): Promise<string | undefined> {
			return Promise.resolve(undefined);
		},
		cleanup(): void {
			if (cleaned) return;
			cleaned = true;
			rmrf(path);
		},
	};
}

export interface VerifierEvidence {
	/** `cmd exit=N; tail: …` — behavioural evidence, never a score. */
	line: string;
	exit?: number;
}

/**
 * Run `rsi.verifier` inside the sandbox and return an *evidence* line.
 * The editor is never shown a score target (P5): this is what happened when the
 * artifact ran, not what the grader wants.
 *
 * Asynchronous and abortable on purpose: the previous `execSync` blocked the
 * extension event loop for up to two minutes, which froze the footer spinner,
 * `watch --follow` polling and — critically — made `/rsi stop` unable to
 * terminate a hung verifier.
 */
export async function runVerifier(
	sandboxPath: string,
	cfg: Pick<RsiConfig, "verifier" | "stageTimeoutMs">,
	signal?: AbortSignal,
): Promise<VerifierEvidence | undefined> {
	if (!cfg.verifier) return undefined;
	const result = await runProcess("/bin/bash", ["-c", cfg.verifier], {
		cwd: sandboxPath,
		timeoutMs: Math.min(cfg.stageTimeoutMs, 120_000),
		signal,
	});
	const body = `${result.stdout}\n${result.stderr}`.trim() || result.error || "";
	if (result.code === 0 && !result.killed) return { line: `${cfg.verifier} exit=0${tailOf(result.stdout)}`, exit: 0 };
	const outcome = result.timedOut ? "timeout" : result.killed ? "aborted" : String(result.code);
	return { line: `${cfg.verifier} exit=${outcome}${tailOf(body)}`, exit: result.killed ? undefined : result.code };
}

function tailOf(text: string, max = 300): string {
	const clean = text.replace(/\s+/g, " ").trim();
	if (clean.length === 0) return "";
	return `; tail: "${clean.slice(-max)}"`;
}

/**
 * Stale sandbox dirs older than this are removed at run start. Long enough to
 * outlive a hung but still-live run, short enough to reclaim crashed ones.
 */
const STALE_SANDBOX_MS = 6 * 60 * 60 * 1000;

export interface CleanupResult {
	/** Orphaned `<worktreeRoot>/*` directories removed. */
	dirs: number;
	/** Whether `git worktree prune` ran (repo only). */
	worktreePruned: boolean;
}

/**
 * Reclaim sandboxes a crashed run leaked: `git worktree prune` clears admin
 * entries whose dirs are gone; orphan dirs under the worktree root older than
 * `STALE_SANDBOX_MS` (and not the active id) are removed. Best-effort — cleanup
 * must never block a run.
 */
export function cleanupSandboxes(
	repoRoot: string,
	cfg: Pick<RsiConfig, "worktreeRoot" | "stageTimeoutMs">,
	opts: { protect?: readonly string[]; staleMs?: number } = {},
): CleanupResult {
	const protect = new Set(opts.protect ?? []);
	const staleMs = opts.staleMs ?? Math.max(STALE_SANDBOX_MS, cfg.stageTimeoutMs * 2);
	let worktreePruned = false;
	if (isGitRepo(repoRoot)) {
		try {
			execFileSync("git", ["worktree", "prune"], { cwd: repoRoot, stdio: ["ignore", "ignore", "ignore"] });
			worktreePruned = true;
		} catch {
			// best-effort
		}
	}

	const root = worktreeRootPath(repoRoot, cfg);
	let dirs = 0;
	if (!existsSync(root)) return { dirs, worktreePruned };
	try {
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			// `protect` holds run ids; a sandbox dir is named `<run-token>-<label>`
			// (see `sandboxId`), so the owning run is recovered from the prefix.
			if (protect.size > 0 && [...protect].some((id) => entry.name.startsWith(`${runToken(id)}-`))) continue;
			const path = join(root, entry.name);
			try {
				if (Date.now() - statSync(path).mtimeMs < staleMs) continue;
			} catch {
				continue;
			}
			rmrf(path);
			dirs++;
		}
	} catch {
		// root disappeared mid-scan — nothing to do
	}
	return { dirs, worktreePruned };
}
