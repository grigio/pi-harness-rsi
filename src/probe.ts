/**
 * Child-`pi` runner and the reference/candidate/composed
 * probes that produce rollouts.
 *
 * Matched conditions: every arm uses the same flags, model, tools and
 * environment; only the staged surface differs. `--approve` is passed only for
 * extension-created sandboxes and run directories, never for the user's cwd.
 *
 * `PI_RSI_FAKE=1` replaces the child process with a deterministic synthetic
 * session so the whole loop runs with zero model calls.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RsiConfig } from "./config";
import { fakeSessionJsonl } from "./fake";
import { digest, sessionUsd, writtenPaths } from "./trajectory";
import { ensureDir, readTextIf, relPosix, rmrf, toPosix, writeText } from "./util";
import { runVerifier, type Sandbox } from "./worktree";

export interface ChildRun {
	code: number;
	stdout: string;
	stderr: string;
	wallMs: number;
	killed: boolean;
	error?: string;
}

/** Env handed to every child: no stale parent-session metadata. */
function childEnv(cfg: RsiConfig): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) {
		delete env[key];
	}
	if (cfg.fake) env.PI_RSI_FAKE = "1";
	return env;
}

export function buildChildArgs(opts: {
	sessionDir: string;
	prompt: string;
	tools: string[];
	model?: string | null;
	thinking?: string | null;
	/** Editor runs are answer-only and context-minimal. */
	editor?: boolean;
}): string[] {
	const args = ["--mode", "json", "--approve", "--session-dir", opts.sessionDir, "--tools", opts.tools.join(",")];
	if (opts.editor) args.push("--no-context-files");
	if (opts.model) args.push("--model", opts.model);
	if (opts.thinking) args.push("--thinking", opts.thinking);
	args.push(opts.prompt);
	return args;
}

/**
 * SIGTERM the whole child process group — `child.kill()` only signals the
 * direct child, so a sandbox `pi` that spawned bash/tool grandchildren would
 * survive a timeout or `/rsi-stop`. `detached: true` (POSIX) makes the child a
 * group leader, so `-pid` reaches the tree; the fallback covers platforms that
 * reject negative pids.
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
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

export function spawnPi(
	args: string[],
	opts: { cwd: string; cfg: RsiConfig; signal?: AbortSignal },
): Promise<ChildRun> {
	const bin = process.env.PI_RSI_PI_BIN ?? "pi";
	const started = Date.now();
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let killed = false;
		let settled = false;

		const child = spawn(bin, args, {
			cwd: opts.cwd,
			env: childEnv(opts.cfg),
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});

		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const timer = setTimeout(() => {
			killed = true;
			killTree(child, "SIGTERM");
			// Escalate if the group ignores SIGTERM.
			killTimer = setTimeout(() => killTree(child, "SIGKILL"), 5_000);
		}, opts.cfg.stageTimeoutMs);

		const onAbort = (): void => {
			killed = true;
			killTree(child, "SIGTERM");
		};
		// The signal may already be aborted by the time we spawn (stop during
		// sandbox setup): an `addEventListener` after the fact never fires.
		if (opts.signal?.aborted) onAbort();
		else opts.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});

		const finish = (code: number, error?: string): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			opts.signal?.removeEventListener("abort", onAbort);
			resolve({ code, stdout, stderr, wallMs: Date.now() - started, killed, error });
		};

		child.on("error", (err) => finish(127, err.message));
		child.on("close", (code) => finish(code ?? (killed ? 124 : 1), killed ? "timed out or aborted" : undefined));
	});
}

/** Newest `.jsonl` under a session dir (pi names files `<timestamp>_<id>.jsonl`). */
export function findSessionFile(sessionDir: string): string | undefined {
	if (!existsDir(sessionDir)) return undefined;
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const abs = join(dir, entry.name);
			if (entry.isDirectory()) walk(abs);
			else if (entry.name.endsWith(".jsonl")) files.push(abs);
		}
	};
	try {
		walk(sessionDir);
	} catch {
		return undefined;
	}
	return files.sort((a, b) => statMtime(b) - statMtime(a))[0];
}

function statMtime(path: string): number {
	return statSync(path).mtimeMs;
}

function existsDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

export interface ProbeRequest {
	label: string;
	/** Sandbox already staged with the surface under test. */
	sandbox: Sandbox;
	prompt: string;
	runDir: string;
	cfg: RsiConfig;
	signal?: AbortSignal;
}

export interface ProbeResult {
	label: string;
	ok: boolean;
	exitCode: number;
	wallMs: number;
	usd: number;
	sessionFile?: string;
	digest: string;
	digestCapped: boolean;
	digestDropped: string[];
	deliverables: string[];
	diffStat?: string;
	verifier?: string;
	error?: string;
}

/** Evidence root inside the run dir (pointers go into missions from here). */
export function evidencePaths(runDir: string): {
	rollouts: string;
	deliverables: string;
	digests: string;
	sessions: string;
} {
	return {
		rollouts: join(runDir, "evidence", "rollouts"),
		deliverables: join(runDir, "evidence", "deliverables"),
		digests: join(runDir, "digests"),
		sessions: join(runDir, "sessions"),
	};
}

/** Run one rollout: child pi in the sandbox → session JSONL → digest + deliverables. */
export async function runProbe(req: ProbeRequest): Promise<ProbeResult> {
	const { cfg, sandbox, runDir, label } = req;
	const paths = evidencePaths(runDir);
	const sessionDir = join(paths.sessions, label);
	rmrf(sessionDir);
	ensureDir(sessionDir);

	let exitCode = 0;
	let wallMs = 0;
	let error: string | undefined;

	if (cfg.fake) {
		const jsonl = fakeSessionJsonl({ label, prompt: req.prompt, kind: "rollout" });
		writeText(join(sessionDir, `fake_${label}.jsonl`), jsonl);
		wallMs = 10;
	} else {
		const args = buildChildArgs({
			sessionDir,
			prompt: req.prompt,
			tools: cfg.tools,
			model: cfg.solverModel,
			thinking: cfg.thinking,
		});
		const run = await spawnPi(args, { cwd: sandbox.path, cfg, signal: req.signal });
		exitCode = run.code;
		wallMs = run.wallMs;
		error = run.error ?? (run.code === 0 ? undefined : run.stderr.slice(-500) || `child pi exited ${run.code}`);
	}

	const sessionFile = findSessionFile(sessionDir);
	if (!sessionFile) {
		return {
			label,
			ok: false,
			exitCode,
			wallMs,
			usd: 0,
			digest: `# digest: ${label}\nerrors:\n  1. child pi produced no session file (${error ?? "unknown error"})`,
			digestCapped: false,
			digestDropped: [],
			deliverables: [],
			error: error ?? "no session file",
		};
	}

	const jsonl = readTextIf(sessionFile) ?? "";
	ensureDir(paths.rollouts);
	const evidenceFile = join(paths.rollouts, `${label}.jsonl`);
	writeText(evidenceFile, jsonl);

	// Deliverables: files the run wrote/edited, copied out of the sandbox.
	const touched = writtenPaths(jsonl);
	const deliverables = harvestDeliverables(sandbox.path, touched, join(paths.deliverables, label));

	const verifierEvidence = runVerifier(sandbox.path, cfg);
	const diffStat = sandbox.diffStat();

	const relPointer = toPosix(join("evidence", "rollouts", `${label}.jsonl`));
	const digestResult = digest({
		label,
		sessionJsonl: jsonl,
		wallSeconds: wallMs / 1000,
		verifier: verifierEvidence?.line,
		diffStat,
		deliverables: deliverables.map((d) => d.rel),
		cap: cfg.budgets.digest,
		pointer: relPointer,
	});
	ensureDir(paths.digests);
	writeText(join(paths.digests, `${label}.md`), digestResult.text);

	return {
		label,
		ok: exitCode === 0 && error === undefined,
		exitCode,
		wallMs,
		usd: sessionUsd(jsonl),
		sessionFile,
		digest: digestResult.text,
		digestCapped: digestResult.capped,
		digestDropped: digestResult.dropped,
		deliverables: deliverables.map((d) => d.rel),
		diffStat,
		verifier: verifierEvidence?.line,
		error,
	};
}

const MAX_DELIVERABLE_FILES = 20;
const MAX_DELIVERABLE_CHARS = 200_000;

interface Harvested {
	rel: string;
}

/** Copy written files out of the sandbox; paths must resolve inside it. */
function harvestDeliverables(sandboxPath: string, touched: readonly string[], destRoot: string): Harvested[] {
	const out: Harvested[] = [];
	for (const raw of touched.slice(0, MAX_DELIVERABLE_FILES)) {
		const abs = raw.startsWith("/") ? raw : join(sandboxPath, raw);
		// `relPosix` normalizes `.`/`..` and escapes — a plain `startsWith` would
		// accept a sibling like `/tmp/sb-evil` for sandbox `/tmp/sb`.
		let rel: string;
		try {
			rel = relPosix(sandboxPath, abs);
		} catch {
			continue;
		}
		let content: string;
		try {
			content = readFileSync(abs, "utf8");
		} catch {
			continue;
		}
		if (content.length > MAX_DELIVERABLE_CHARS)
			content = `${content.slice(0, MAX_DELIVERABLE_CHARS)}\n…[deliverable capped]`;
		writeText(join(destRoot, rel), content);
		out.push({ rel: `evidence/deliverables/${basename(destRoot)}/${rel}` });
	}
	return out;
}

function basename(p: string): string {
	const parts = p.split(/[\\/]/);
	return parts[parts.length - 1] || p;
}
