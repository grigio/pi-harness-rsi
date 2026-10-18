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
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RsiConfig } from "./config";
import { ensureDir, listFiles, readTextIf, rmrf, toPosix, writeText } from "./util";
import { writeSurface, type Surface } from "./surface";

export type SandboxKind = "worktree" | "copy";

export interface Sandbox {
	readonly path: string;
	readonly kind: SandboxKind;
	/** Stage a surface into the sandbox (prunes surface files the candidate dropped). */
	stage(surface: Surface): void;
	/** `+A −D` numstat against HEAD, when the sandbox is a git worktree. */
	diffStat(): string | undefined;
	/** Idempotent removal (called from `finally`). */
	cleanup(): void;
}

export function isGitRepo(root: string): boolean {
	try {
		return execSync("git rev-parse --is-inside-work-tree", {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim() === "true";
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
	if (readTextIf(gitignore) !== "worktrees/\nruns/\n") writeText(gitignore, "worktrees/\nruns/\n");
}

/** Resolved sandbox root inside the repo (relative settings resolve from the repo). */
export function worktreeRootPath(repoRoot: string, cfg: Pick<RsiConfig, "worktreeRoot">): string {
	return cfg.worktreeRoot.startsWith("/") ? cfg.worktreeRoot : join(repoRoot, cfg.worktreeRoot);
}

export interface PrepareOptions {
	/** Unique per rollout — the sandbox lives at `<worktreeRoot>/<id>`. */
	id: string;
	/** Skip the dirty-tree refusal (only reachable via `/rsi --force`). */
	force?: boolean;
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

	if (isGitRepo(repoRoot)) {
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
	// copyDir is imported lazily to keep the hot path (worktree) allocation-free
	copyTreeSync(source, path);
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
		diffStat(): string | undefined {
			try {
				execFileSync("git", ["add", "-A"], { cwd: path, stdio: ["ignore", "ignore", "ignore"] });
				const numstat = execFileSync("git", ["diff", "--cached", "--numstat", "HEAD"], {
					cwd: path,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				});
				let added = 0;
				let removed = 0;
				for (const line of numstat.split("\n")) {
					const m = line.match(/^(\d+)\t(\d+)\t/);
					if (!m) continue;
					added += Number(m[1]);
					removed += Number(m[2]);
				}
				return `+${added} −${removed}`;
			} catch {
				return undefined;
			}
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
		diffStat(): string | undefined {
			return undefined;
		},
		cleanup(): void {
			if (cleaned) return;
			cleaned = true;
			rmrf(path);
		},
	};
}

function copyTreeSync(src: string, dst: string): void {
	const files = listFiles(src, { excludeDirs: COPY_EXCLUDES, maxFiles: 20000 });
	for (const rel of files) {
		writeText(join(dst, rel), readTextIf(join(src, rel)) ?? "");
	}
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
 */
export function runVerifier(sandboxPath: string, cfg: Pick<RsiConfig, "verifier" | "stageTimeoutMs">): VerifierEvidence | undefined {
	if (!cfg.verifier) return undefined;
	try {
		const out = execSync(cfg.verifier, {
			cwd: sandboxPath,
			shell: "/bin/bash",
			encoding: "utf8",
			timeout: Math.min(cfg.stageTimeoutMs, 120_000),
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { line: `${cfg.verifier} exit=0${tailOf(out)}`, exit: 0 };
	} catch (err) {
		const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
		const exit = typeof e.status === "number" ? e.status : undefined;
		const body = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim() || e.message || "";
		return { line: `${cfg.verifier} exit=${exit ?? "?"}${tailOf(body)}`, exit };
	}
}

function tailOf(text: string, max = 300): string {
	const clean = text.replace(/\s+/g, " ").trim();
	if (clean.length === 0) return "";
	return `; tail: "${clean.slice(-max)}"`;
}

/** Absolute path of the live tree's harness run/library root. */
export function harnessRoot(repoRoot: string): string {
	return join(repoRoot, ".pi", "harness");
}

export function relFrom(root: string, target: string): string {
	const rel = toPosix(target.startsWith(root) ? target.slice(root.length).replace(/^\/+/, "") : target);
	return rel;
}

export function sandboxExists(path: string): boolean {
	return existsSync(path);
}
