/**
 * Loop orchestration: snapshot → probe → propose → probe →
 * compose → probe → select → adopt → reflect, with the budget identity
 * `R = 4k`, `P = 3k` asserted on the ledger.
 *
 * The orchestrator runs in the user's session but never does solver work
 * itself: every rollout and every editor job is a child `pi` process (or a
 * deterministic fake under `PI_RSI_FAKE=1`).
 *
 * Fail-closed (P3): any invalid proposal retries once with the verbatim
 * validator error, then inherits the current surface. Nothing here ever
 * half-applies an edit, and nothing touches the live tree without the
 * adoption gate.
 */

import { join } from "node:path";
import type { RsiConfig } from "./config";
import { BudgetError, type MissionPart } from "./context";
import {
	buildMission,
	composeParts,
	type EditorStage,
	parseChoice,
	parseEdits,
	parseExperience,
	proposeParts,
	ReplyParseError,
	reflectParts,
	runEditor,
	selectParts,
} from "./editor";
import type { FakeEditorContext } from "./fake";
import { assertAdoptionAllowed, DirtyTreeError, workingTreeStatus } from "./guard";
import {
	addEntry,
	assertIdentity,
	type IdentityReport,
	type LedgerFile,
	loadLedger,
	newLedger,
	pushNote,
	renderStatus,
	saveLedger,
	totalUsd,
} from "./ledger";
import { adoptSurface, loadLessons, regenerateIndex, writeLessonIfValid } from "./library";
import { acquireRunLock, RunLockedError } from "./lock";
import { type ProbeResult, runProbe } from "./probe";
import { pruneRuns } from "./retention";
import { latestRunId, runsDir } from "./runs";
import {
	buildPool,
	fallbackChoice,
	isTrivialSelection,
	renderCandidates,
	type SelectionRecord,
	saveSelection,
	selectionSeed,
} from "./selection";
import {
	applyDelta,
	diffSurface,
	readSurface,
	renderScriptReview,
	type Surface,
	type SurfaceDelta,
	type SurfaceDiff,
	surfaceFromJson,
	surfaceToJson,
	validate,
	writeSurface,
} from "./surface";
import {
	exists,
	extractTag,
	hash12,
	jaccardLines,
	listFiles,
	mapLimit,
	nowRunId,
	readTextIf,
	sanitizeSegment,
	slugify,
	writeText,
} from "./util";
import { type ActiveRun, beginRun, endRun, pushLiveNote, type RunKind, STOP_FILE, setStage } from "./watch";
import { cleanupSandboxes, ensureHarnessIgnored, prepareSandbox, type Sandbox } from "./worktree";

// __PART2__

export type LogLevel = "info" | "warn" | "error" | "success";

export interface LoopIO {
	log(message: string, level?: LogLevel): void;
	/** Adoption gate (P6). Omit for headless/test runs — adoption then needs `/rsi-adopt`. */
	confirmAdoption?(title: string, message: string): Promise<boolean>;
}

export interface LoopOptions {
	cfg: RsiConfig;
	/** Live working tree (git root when there is one). */
	cwd: string;
	task: string;
	domain: string;
	/** Run even when the working tree is dirty (adoption still checks it). */
	force?: boolean;
	signal?: AbortSignal;
	io: LoopIO;
	/** Pre-generated run id (tests pin it); defaults to a timestamp slug. */
	runId?: string;
}

export type Outcome = LedgerFile["outcome"];

export interface LoopReport {
	runId: string;
	runDir: string;
	outcome: Outcome;
	chosen: string | null;
	adopted: boolean;
	identity: IdentityReport;
	usd: number;
	status: string;
	notes: string[];
	errors: string[];
}

const silent: LoopIO = { log: () => {} };

interface RunContext {
	runId: string;
	runDir: string;
	ledger: LedgerFile;
	io: LoopIO;
	cfg: RsiConfig;
	cwd: string;
	task: string;
	domain: string;
	errors: string[];
	budgetsUsed: Record<string, number>;
	/** Live registry entry (/rsi-watch) + merged abort signal (/rsi-stop). */
	watch: ActiveRun;
	signal: AbortSignal;
	/** The live tree matched HEAD at run start (worktree sandboxes are safe);
	 * otherwise probes copy the live tree so they measure exactly this surface. */
	clean: boolean;
	/** Releases the cross-process run lock; idempotent. */
	releaseLock: () => void;
}

/**
 * Register the run in the live registry and merge the caller's signal into the
 * stop controller, so both `/rsi-stop` and `LoopOptions.signal` interrupt it.
 */
function attachWatch(
	target: { runId: string; runDir: string; task: string; domain: string; kind: RunKind },
	external?: AbortSignal,
): { watch: ActiveRun; signal: AbortSignal } {
	const run = beginRun(target);
	if (external) {
		if (external.aborted) run.controller.abort();
		else external.addEventListener("abort", () => run.controller.abort(), { once: true });
	}
	return { watch: run, signal: run.controller.signal };
}

function createRun(opts: LoopOptions, outcome: Outcome = "running"): RunContext {
	const runId = opts.runId ?? nowRunId(opts.task);
	const lock = acquireRunLock(opts.cwd, runId);
	if (!lock.ok) throw new RunLockedError(lock.holder);
	let started = false;
	try {
		const pruned = pruneRuns(opts.cwd, { keepRuns: opts.cfg.keepRuns, protect: [runId] });
		const runsRoot = join(opts.cwd, ".pi", "harness", "runs");
		const runDir = join(runsRoot, runId);
		ensureHarnessIgnored(opts.cwd);
		const cleaned = cleanupSandboxes(opts.cwd, opts.cfg, { protect: [runId] });
		const ledger = newLedger(runId, opts.task, sanitizeSegment(opts.domain), opts.cfg);
		ledger.outcome = outcome;
		const live = attachWatch(
			{
				runId,
				runDir,
				task: opts.task,
				domain: sanitizeSegment(opts.domain),
				kind: outcome === "probed" ? "probe" : "loop",
			},
			opts.signal,
		);
		started = true;
		const ctx: RunContext = {
			runId,
			runDir,
			ledger,
			io: opts.io ?? silent,
			cfg: opts.cfg,
			cwd: opts.cwd,
			task: opts.task,
			domain: sanitizeSegment(opts.domain),
			errors: [],
			budgetsUsed: {},
			watch: live.watch,
			signal: live.signal,
			clean: !workingTreeStatus(opts.cwd).dirty,
			releaseLock: lock.release,
		};
		save(ctx);
		writeText(join(runDir, "task.txt"), opts.task);
		if (pruned.removed.length > 0) {
			note(ctx, `retention: pruned ${pruned.removed.length} old run(s), keepRuns=${opts.cfg.keepRuns}`);
		}
		if (cleaned.dirs > 0) {
			note(ctx, `cleanup: removed ${cleaned.dirs} stale sandbox dir(s) under the worktree root`);
		}
		return ctx;
	} catch (err) {
		if (started) endRun(runId);
		lock.release();
		throw err;
	}
}

function save(ctx: RunContext): void {
	saveLedger(ctx.runDir, ctx.ledger);
}

function note(ctx: RunContext, text: string, level: LogLevel = "info"): void {
	pushNote(ctx.ledger, text);
	pushLiveNote(ctx.watch, text);
	ctx.io.log(text, level);
	save(ctx);
}

function recordBudget(ctx: RunContext, stage: string, used: number): void {
	ctx.budgetsUsed[stage] = Math.max(ctx.budgetsUsed[stage] ?? 0, used);
	ctx.ledger.budgetsUsed[stage] = ctx.budgetsUsed[stage];
	save(ctx);
}

/** Hard stop: never start a stage past `rsi.maxUsd` (best-so-far surface kept). */
function outOfBudget(ctx: RunContext): boolean {
	const spent = totalUsd(ctx.ledger);
	if (spent >= ctx.cfg.maxUsd) {
		note(
			ctx,
			`budget stop: spent ${spent.toFixed(4)} USD ≥ max ${ctx.cfg.maxUsd} — keeping the current surface`,
			"warn",
		);
		return true;
	}
	return false;
}

/** User interruption (`/rsi-stop`, or a `STOP` file from another session) wins over the budget check; both fail closed. */
function stopOutcome(ctx: RunContext): Outcome | null {
	if (ctx.signal.aborted || exists(join(ctx.runDir, STOP_FILE))) return "aborted";
	if (outOfBudget(ctx)) return "aborted_budget";
	return null;
}

function solverPrompt(task: string): string {
	return [
		"You are working in an isolated checkout of this project.",
		"",
		"Task:",
		task,
		"",
		"Work only inside this directory. Leave the finished work in the working tree (do not commit).",
		"Finish with a short summary of what you changed and which checks you ran.",
	].join("\n");
}

/**
 * One rollout: fresh sandbox, stage the surface under test, probe, harvest
 * evidence, clean up in `finally`.
 */
async function probeSurface(
	ctx: RunContext,
	surface: Surface,
	label: string,
	opts: { signal?: AbortSignal } = {},
): Promise<ProbeResult> {
	const cfg = ctx.cfg;
	const id = `${label}-${hash12(`${ctx.runId}:${label}`).slice(0, 8)}`;
	setStage(ctx.watch, `probe ${label}`);
	const sandbox: Sandbox = prepareSandbox(ctx.cwd, cfg, {
		id,
		forceCopy: !ctx.clean,
		copySource: ctx.cwd,
	});
	try {
		writeText(join(ctx.runDir, "surfaces", `${label}.json`), surfaceToJson(surface));
		sandbox.stage(surface);
		const result = await runProbe({
			label,
			sandbox,
			prompt: solverPrompt(ctx.task),
			runDir: ctx.runDir,
			cfg,
			signal: opts.signal,
		});
		addEntry(ctx.ledger, { kind: "rollout", label, usd: result.usd, attempts: 1, wallMs: result.wallMs });
		if (!result.ok) note(ctx, `rollout ${label} exited ${result.exitCode}: ${result.error ?? "unknown error"}`, "warn");
		save(ctx);
		return result;
	} finally {
		sandbox.cleanup();
	}
}

function diffText(label: string, diff: SurfaceDiff): string {
	const changed = [
		...diff.added.map((p) => `+ ${p}`),
		...diff.removed.map((p) => `- ${p}`),
		...diff.modified.map((p) => `~ ${p}`),
	];
	return [
		`${label}: added ${diff.added.length}, removed ${diff.removed.length}, modified ${diff.modified.length}, ` +
			`always-on Δ ${diff.alwaysOnDelta >= 0 ? "+" : ""}${diff.alwaysOnDelta} chars, surface Δ ` +
			`${diff.charsDelta >= 0 ? "+" : ""}${diff.charsDelta} chars`,
		...(changed.length > 0 ? changed.map((c) => `  ${c}`) : ["  (no file changes)"]),
	].join("\n");
}

interface ProposedCandidate {
	ok: boolean;
	surface: Surface;
	delta: SurfaceDelta;
	notes: string;
	usd: number;
	/** Verbatim last failure when `ok` is false. */
	failure?: string;
}

interface ProposeArgs {
	lever: EditorStage;
	index: number;
	base: Surface;
	refDigest: string;
	evidence: string[];
	library: { index?: string; lessons: string[] };
	/** Notes carried from earlier indices (sequential mode). */
	carry?: string;
	signal?: AbortSignal;
}

/**
 * Shared editor stage body: assemble → run → parse → validate, with exactly
 * one retry carrying the verbatim validator error, then fail closed to the base
 * surface (P3). One ledger `session` entry per stage, so retries never inflate
 * the `P = 3k` identity.
 */
async function runEditorStage(
	ctx: RunContext,
	args: {
		label: string;
		stage: EditorStage;
		budgetStage: "propose" | "compose";
		base: Surface;
		ledgerLabel: string;
		fake: Omit<FakeEditorContext, "attempt" | "scenario" | "validationError">;
		buildParts: (info: { lastError: string; attempt: number }) => MissionPart[];
		signal?: AbortSignal;
	},
): Promise<ProposedCandidate> {
	const { cfg, runDir } = ctx;
	const { label } = args;
	let lastError = "";
	let spentUsd = 0;
	let attempts = 0;

	for (let attempt = 0; attempt < 2; attempt++) {
		if (ctx.signal.aborted || outOfBudget(ctx)) break;
		const parts = args.buildParts({ lastError, attempt });

		let mission: ReturnType<typeof buildMission>;
		try {
			mission = buildMission(args.budgetStage, parts, cfg, runDir, `${label}-a${attempt}`);
		} catch (err) {
			if (err instanceof BudgetError) {
				lastError = err.message;
				note(ctx, `${label}: ${args.budgetStage} mission over budget — ${err.message}`, "warn");
				break;
			}
			throw err;
		}
		recordBudget(ctx, args.budgetStage, mission.mission.used);

		const run = await runEditor({
			stage: args.stage,
			mission: mission.mission,
			missionPath: mission.path,
			runDir,
			cfg,
			attempt,
			fake: args.fake,
			signal: args.signal,
		});
		// One ledger entry per *stage*: `attempts` records retries, so the
		// P = 3k identity counts improvement sessions, not attempts.
		attempts++;
		spentUsd += run.usd;

		if (!run.ok) {
			ctx.ledger.counters.editorErrors++;
			lastError = `editor run failed: ${run.error ?? "no reply"}`;
			note(ctx, `${label}: ${lastError}`, "warn");
			continue;
		}

		try {
			const parsed = parseEdits(run.reply, cfg);
			const candidate = applyDelta(args.base, parsed.delta);
			// Delta-only validation: only problems this proposal *adds* block it.
			const report = validate(candidate, cfg, { where: label, base: args.base });
			if (report.errors.length > 0) {
				lastError = report.errors.join("\n");
				if (report.errors.some((e) => e.includes("tripwire") || e.includes("forbidden path"))) {
					ctx.ledger.counters.tripwire++;
				}
				note(ctx, `${label}: validation failed (attempt ${attempt + 1}/2)`, "warn");
				continue;
			}
			for (const warning of report.warnings) note(ctx, `${label}: ${warning}`);
			writeText(join(runDir, "notes", `${label}.txt`), parsed.notes);
			addEntry(ctx.ledger, { kind: "session", label: args.ledgerLabel, usd: spentUsd, attempts, wallMs: run.wallMs });
			save(ctx);
			return { ok: true, surface: candidate, delta: parsed.delta, notes: parsed.notes, usd: run.usd };
		} catch (err) {
			if (err instanceof ReplyParseError) {
				lastError = err.message;
				note(ctx, `${label}: unparsable reply (attempt ${attempt + 1}/2)`, "warn");
				continue;
			}
			lastError = (err as Error).message;
			note(ctx, `${label}: ${lastError}`, "warn");
		}
	}

	// Fail closed to the current surface (P3).
	ctx.ledger.counters.keptBase++;
	ctx.ledger.counters.fellBack++;
	const failure = lastError || `${args.budgetStage} produced no valid delta`;
	addEntry(ctx.ledger, { kind: "session", label: args.ledgerLabel, usd: spentUsd, attempts, wallMs: attempts * 1 });
	note(ctx, `${label}: fell back to the current surface — ${failure.slice(0, 200)}`, "warn");
	return { ok: false, surface: args.base, delta: { files: [] }, notes: failure, usd: 0, failure };
}

/** INV/DOM proposal with exactly one retry carrying the verbatim validator error. */
async function proposeStage(ctx: RunContext, args: ProposeArgs): Promise<ProposedCandidate> {
	const stage = args.lever;
	const label = stage === "propose-inv" ? `inv${args.index}` : `dom${args.index}`;
	return runEditorStage(ctx, {
		label,
		stage,
		budgetStage: "propose",
		base: args.base,
		ledgerLabel: `propose-${label}`,
		signal: args.signal,
		fake: { stage, domain: ctx.domain, skillName: `${ctx.domain}-notes`, baseAgents: args.base["AGENTS.md"] ?? "" },
		buildParts: ({ lastError, attempt }) => {
			const parts = proposeParts(
				stage,
				{
					task: ctx.task,
					domain: ctx.domain,
					surface: args.base,
					evidence: args.evidence,
					digests: [args.refDigest],
					libraryIndex: args.library.index,
					libraryLessons: args.library.lessons,
					carry: attempt > 0 ? lastError : args.carry,
				},
				ctx.cfg,
			);
			if (attempt > 0) {
				parts.push({ name: "validator feedback (fix exactly this, nothing else)", text: lastError });
			}
			return parts;
		},
	});
}

interface ComposeArgs {
	index: number;
	base: Surface;
	refProbe: ProbeResult;
	candidates: ProposedCandidate[];
	library: { index?: string; lessons: string[] };
	carry?: string;
	signal?: AbortSignal;
}

/** Compose one final surface from contrastive digests (never from full trajectories). */
async function composeStage(ctx: RunContext, args: ComposeArgs): Promise<ProposedCandidate> {
	const { runDir } = ctx;
	const label = `final${args.index}`;
	setStage(ctx.watch, `compose ${label}`);
	const leverNames = ["inv", "dom"];

	const contrast: string[] = [`=== reference ref${args.index} ===\n${args.refProbe.digest}`];
	for (const [i, cand] of args.candidates.entries()) {
		contrast.push(
			`=== candidate ${leverNames[i]}${args.index} (${i === 0 ? "procedure" : "practitioner knowledge"}) ===\n${cand.notes ? `notes: ${cand.notes}\n` : ""}${candidateDigest(cand, runDir, `${leverNames[i]}${args.index}`)}`,
		);
	}
	const diffs = args.candidates.map((cand, i) =>
		diffText(`${leverNames[i]}${args.index} vs current`, diffSurface(args.base, cand.surface)),
	);
	const decisionNotes = args.candidates.map(
		(cand, i) => `[${leverNames[i]}${args.index}] ${cand.notes || "(no notes)"}`,
	);

	return runEditorStage(ctx, {
		label,
		stage: "compose",
		budgetStage: "compose",
		base: args.base,
		ledgerLabel: `compose-${label}`,
		signal: args.signal,
		fake: {
			stage: "compose",
			domain: ctx.domain,
			skillName: `${ctx.domain}-notes`,
			baseAgents: args.base["AGENTS.md"] ?? "",
		},
		buildParts: ({ lastError, attempt }) => {
			const parts = composeParts(
				{
					task: ctx.task,
					domain: ctx.domain,
					surface: args.base,
					evidence: diffs,
					digests: [],
					contrast,
					decisionNotes,
					libraryIndex: args.library.index,
					libraryLessons: args.library.lessons,
					carry: attempt > 0 ? lastError : args.carry,
				},
				ctx.cfg,
			);
			if (attempt > 0) parts.push({ name: "validator feedback (fix exactly this, nothing else)", text: lastError });
			return parts;
		},
	});
}

/** Digests live on disk; the compose mission gets them by pointer (P2). */
function candidateDigest(cand: ProposedCandidate, runDir: string, label: string): string {
	if (!cand.ok) return "(candidate fell back to the current surface — no digest)";
	const text = readTextIf(join(runDir, "digests", `${label}.md`));
	return text ?? "(no digest recorded)";
}

function range(n: number): number[] {
	return Array.from({ length: n }, (_, i) => i);
}

function evidenceFor(index: number): string[] {
	return [`evidence/rollouts/ref${index}.jsonl`, `digests/ref${index}.md`];
}

function surfaceText(surface: Surface): string {
	return Object.keys(surface)
		.sort()
		.map((p) => `${p}\n${surface[p]}`)
		.join("\n\u0000");
}

/** Mean line-Jaccard across composed candidates (mode-collapse detector). */
export function diversityOf(surfaces: readonly Surface[]): number | null {
	if (surfaces.length < 2) return null;
	let sum = 0;
	let pairs = 0;
	for (let i = 0; i < surfaces.length; i++) {
		for (let j = i + 1; j < surfaces.length; j++) {
			sum += jaccardLines(surfaceText(surfaces[i]), surfaceText(surfaces[j]));
			pairs++;
		}
	}
	return pairs > 0 ? sum / pairs : null;
}

/** `/rsi-probe <task>` — reference executions + digests only, zero edits (P0). */
export async function runReferenceProbes(opts: LoopOptions): Promise<LoopReport> {
	const ctx = createRun(opts, "probed");
	try {
		const base = readSurface(opts.cwd, opts.cfg);
		if (base["AGENTS.md"] === undefined) base["AGENTS.md"] = "# Project instructions\n";
		writeText(join(ctx.runDir, "base", "surface.json"), surfaceToJson(base));
		setStage(ctx.watch, `probe ×${opts.cfg.k} (references)`);
		const stop = stopOutcome(ctx);
		if (stop) return finish(ctx, { outcome: stop });

		const refs = await mapLimit(range(opts.cfg.k), opts.cfg.maxParallel, (i) =>
			probeSurface(ctx, base, `ref${i}`, { signal: ctx.signal }),
		);
		for (const ref of refs) {
			note(
				ctx,
				`ref${ref.label.slice(3)}: ${ref.digest.split("\n")[0]} — ${ref.deliverables.length} deliverable file(s), verifier=${ref.verifier ? "yes" : "no"}`,
			);
		}
		return finish(ctx, { outcome: "probed" });
	} catch (err) {
		ctx.errors.push((err as Error).message);
		note(ctx, `error: ${(err as Error).message}`, "error");
		return finish(ctx, { outcome: "error", errors: true });
	}
}

/** `/rsi <task>` — the full task-level recursion. */
export async function runLoop(opts: LoopOptions): Promise<LoopReport> {
	const cfg = opts.cfg;
	const ctx = createRun(opts, "running");

	try {
		if (cfg.requireClean && !opts.force) {
			const status = workingTreeStatus(opts.cwd);
			if (status.dirty) throw new DirtyTreeError(status.lines);
		}

		// --- snapshot(base) -------------------------------------------------
		const base = readSurface(opts.cwd, cfg);
		if (base["AGENTS.md"] === undefined) {
			base["AGENTS.md"] = "# Project instructions\n";
			note(ctx, "no AGENTS.md in the working tree — synthesized an empty always-on file for this run");
		}
		writeText(join(ctx.runDir, "base", "surface.json"), surfaceToJson(base));
		const baseReport = validate(base, cfg, { where: "base" });
		for (const warning of baseReport.warnings) note(ctx, warning);
		if (baseReport.errors.length > 0) {
			note(ctx, `base surface carries ${baseReport.errors.length} pre-existing issue(s); candidates must not add more`);
		}

		const library = loadLessons(opts.cwd, cfg, ctx.domain, opts.task);
		const k = cfg.k;

		// --- probe(base) ×k  (R += k) ---------------------------------------
		setStage(ctx.watch, `probe ×${k} (references)`);
		const stop = stopOutcome(ctx);
		if (stop) return finish(ctx, { outcome: stop });
		const refs = await mapLimit(range(k), cfg.maxParallel, (i) =>
			probeSurface(ctx, base, `ref${i}`, { signal: ctx.signal }),
		);

		// --- propose INV/DOM ×2k (P += 2k) ----------------------------------
		const composed: Array<{ label: string; candidate: ProposedCandidate }> = [];
		const finalProbes: ProbeResult[] = [];
		let carry: string | undefined;

		const proposeAll = async (index: number): Promise<ProposedCandidate[]> => {
			setStage(ctx.watch, `propose ×2 (index ${index})`);
			const argsFor = (lever: EditorStage): ProposeArgs => ({
				lever,
				index,
				base,
				refDigest: refs[index].digest,
				evidence: evidenceFor(index),
				library,
				carry,
				signal: ctx.signal,
			});
			if (cfg.mode === "sequential") {
				const inv = await proposeStage(ctx, argsFor("propose-inv"));
				const dom = await proposeStage(ctx, argsFor("propose-dom"));
				return [inv, dom];
			}
			return mapLimit(["propose-inv", "propose-dom"] as const, cfg.maxParallel, (lever) =>
				proposeStage(ctx, argsFor(lever)),
			);
		};

		for (const index of range(k)) {
			let stop = stopOutcome(ctx);
			if (stop) return finish(ctx, { outcome: stop, errors: true });

			const candidates = await proposeAll(index);
			stop = stopOutcome(ctx);
			if (stop) return finish(ctx, { outcome: stop, errors: true });

			// --- probe(candidates) (R += 2k) --------------------------------
			const labels = [`inv${index}`, `dom${index}`];
			const candProbes = await mapLimit(
				range(2).map((j) => ({ surface: candidates[j].surface, label: labels[j] })),
				cfg.maxParallel,
				(job) => probeSurface(ctx, job.surface, job.label, { signal: ctx.signal }),
			);
			void candProbes; // digests are read back from disk by candidateDigest()

			stop = stopOutcome(ctx);
			if (stop) return finish(ctx, { outcome: stop, errors: true });

			// --- compose (P += k) -------------------------------------------
			const finalCandidate = await composeStage(ctx, {
				index,
				base,
				refProbe: refs[index],
				candidates,
				library,
				carry,
				signal: ctx.signal,
			});
			composed.push({ label: `final${index}`, candidate: finalCandidate });
			carry =
				candidates
					.map((c) => c.notes)
					.filter(Boolean)
					.join(" | ")
					.slice(0, 500) || undefined;

			stop = stopOutcome(ctx);
			if (stop) return finish(ctx, { outcome: stop, errors: true });

			// --- probe(final) (R += k) ---------------------------------------
			setStage(ctx.watch, `probe final${index}`);
			const finalProbe = await probeSurface(ctx, finalCandidate.surface, `final${index}`, { signal: ctx.signal });
			finalProbes.push(finalProbe);
			note(
				ctx,
				`final${index}: ${finalProbe.digest.split("\n")[0]} — diff ${diffSurface(base, finalCandidate.surface).added.length + diffSurface(base, finalCandidate.surface).modified.length} file(s) changed`,
			);
		}

		// --- select (k>1 only) ----------------------------------------------
		setStage(ctx.watch, "select");
		const selection = await selectStage(ctx, {
			finalProbes,
			composed,
			signal: ctx.signal,
		});
		const chosenLabel = selection.chosenLabel ?? "final0";
		const chosenEntry = composed.find((c) => c.label === chosenLabel) ?? composed[0];
		if (!chosenEntry) {
			note(ctx, "no composed candidate exists — nothing to adopt", "warn");
			return finish(ctx, { outcome: "fell_back", chosen: null, errors: true });
		}

		ctx.ledger.diversity = diversityOf(composed.map((c) => c.candidate.surface));
		save(ctx);

		// --- adopt (human gate) ---------------------------------------------
		setStage(ctx.watch, "adopt gate");
		const gate = await resolveAdoptionGate(ctx, chosenLabel, chosenEntry.candidate.surface, base, opts);
		if (!gate.ok) {
			if (gate.stopped) return finish(ctx, { outcome: "aborted", chosen: chosenLabel });
			return finish(ctx, { outcome: gate.aborted ? "error" : "pending", chosen: chosenLabel, errors: gate.aborted });
		}
		return finish(ctx, { outcome: "adopted", chosen: chosenLabel, adopted: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		ctx.errors.push(message);
		note(ctx, `error: ${message}`, "error");
		const aborted = err instanceof BudgetError;
		return finish(ctx, { outcome: aborted ? "aborted_budget" : "error", errors: true });
	}
}

// ---------------------------------------------------------------------------
// Selection, adoption gate, reflection, finalization
// ---------------------------------------------------------------------------

interface SelectArgs {
	finalProbes: ProbeResult[];
	composed: Array<{ label: string; candidate: ProposedCandidate }>;
	signal?: AbortSignal;
}

/** k>1: anonymized deliverables + seeded shuffle. k=1: stage does not exist. */
async function selectStage(ctx: RunContext, args: SelectArgs): Promise<SelectionRecord> {
	const cfg = ctx.cfg;
	if (isTrivialSelection(cfg.k)) {
		const record: SelectionRecord = {
			order: args.composed.map((c, i) => ({ id: `c${i}`, label: c.label })),
			chosenLabel: args.finalProbes[0]?.label ?? args.composed[0]?.label ?? "final0",
			chosenId: "c0",
			why: "trivial_selection: k=1, no selection stage ran",
			seed: "none",
			trivial: true,
		};
		saveSelection(ctx.runDir, record);
		return record;
	}

	if (ctx.signal.aborted || outOfBudget(ctx)) {
		const fallback = { label: args.composed[0]?.label ?? "final0" };
		const record: SelectionRecord = {
			order: args.composed.map((c, i) => ({ id: `c${i}`, label: c.label })),
			chosenLabel: fallback.label,
			chosenId: "c0",
			why: ctx.signal.aborted
				? "run interrupted before selection — fail-open to the first composed candidate"
				: "budget stop before selection — fail-open to the first composed candidate",
			seed: "none",
			trivial: false,
		};
		saveSelection(ctx.runDir, record);
		return record;
	}

	const seed = selectionSeed(ctx.runId);
	const pool = buildPool(args.finalProbes, ctx.runDir, cfg, seed);
	const mission = buildMission(
		"select",
		selectParts({ task: ctx.task, candidates: renderCandidates(pool) }, cfg),
		cfg,
		ctx.runDir,
		"selection",
	);
	recordBudget(ctx, "select", mission.mission.used);

	const run = await runEditor({
		stage: "select",
		mission: mission.mission,
		missionPath: mission.path,
		runDir: ctx.runDir,
		cfg,
		attempt: 0,
		fake: { stage: "select", domain: ctx.domain, skillName: `${ctx.domain}-notes`, baseAgents: "" },
		signal: args.signal,
	});
	addEntry(ctx.ledger, { kind: "selection", label: "selection", usd: run.usd, attempts: 1, wallMs: run.wallMs });
	save(ctx);

	let chosenId: string | null = null;
	let why = extractTag(run.reply, "why") ?? "";
	try {
		chosenId = parseChoice(
			run.reply,
			pool.map((c) => c.id),
		);
	} catch (err) {
		const fallback = fallbackChoice(pool);
		chosenId = fallback?.id ?? null;
		why = `fail-open: ${(err as Error).message}`;
		note(
			ctx,
			`selection failed — fail-open to ${chosenId ?? "nothing"}: ${(err as Error).message.slice(0, 160)}`,
			"warn",
		);
	}
	const chosen = pool.find((c) => c.id === chosenId) ?? pool[0];
	const record: SelectionRecord = {
		order: pool.map((c) => ({ id: c.id, label: c.label })),
		chosenLabel: chosen?.label ?? args.composed[0]?.label ?? "final0",
		chosenId: chosen?.id ?? null,
		why: why.slice(0, 400),
		seed: String(seed),
		trivial: false,
	};
	saveSelection(ctx.runDir, record);
	note(ctx, `selection: ${record.chosenLabel} (${record.chosenId}) — identity map kept in selection.json`);
	return record;
}

interface GateResult {
	ok: boolean;
	aborted?: boolean;
	/** The run was interrupted (/rsi-stop) before the gate — close as `aborted`. */
	stopped?: boolean;
	message: string;
}

/** Human adoption gate (P6) + library snapshot + reflection. */
async function resolveAdoptionGate(
	ctx: RunContext,
	label: string,
	surface: Surface,
	base: Surface,
	opts: LoopOptions,
): Promise<GateResult> {
	const cfg = ctx.cfg;
	if (ctx.signal.aborted) {
		return { ok: false, stopped: true, message: "run interrupted before the adoption gate" };
	}
	const dirty = workingTreeStatus(ctx.cwd);
	if (dirty.dirty && !opts.force) {
		const err = new DirtyTreeError(dirty.lines);
		note(ctx, `adoption refused: ${err.message}`, "warn");
		return { ok: false, aborted: true, message: err.message };
	}

	let confirmed = !cfg.confirmAdopt;
	if (!confirmed) {
		const summary = diffText(`adopt ${label}`, diffSurface(base, surface));
		const scriptReview = renderScriptReview(base, surface);
		if (opts.io.confirmAdoption) {
			confirmed = await opts.io.confirmAdoption(
				`rsi: adopt ${label}?`,
				`${summary}${scriptReview ? `\n\n${scriptReview}` : ""}\n\nThe live tree is updated and a library snapshot is written.`,
			);
		} else {
			note(ctx, `adoption pending: ${label} — no confirmation channel here, run /rsi-adopt ${label}`, "warn");
			return { ok: false, message: "confirmation required" };
		}
	}
	if (!confirmed) {
		note(ctx, `adoption declined for ${label} — candidate kept under ${ctx.runDir}/surfaces/${label}.json`, "warn");
		return { ok: false, message: "declined" };
	}

	try {
		assertAdoptionAllowed(cfg, true);
	} catch (err) {
		return { ok: false, message: (err as Error).message };
	}

	const liveBefore = readSurface(ctx.cwd, cfg);
	writeSurface(ctx.cwd, surface, { prune: true });
	adoptSurface(ctx.cwd, cfg, { domain: ctx.domain, slug: slugify(ctx.task), liveBefore, adopted: surface });
	regenerateIndex(ctx.cwd, cfg, ctx.domain);
	ctx.ledger.adopted = true;
	save(ctx);
	note(ctx, `adopted ${label} into the live tree; library entry ${ctx.domain}/${slugify(ctx.task)}`, "success");

	await reflectStage(ctx, { label, base: liveBefore, adopted: surface, signal: ctx.signal });
	return { ok: true, message: "adopted" };
}

/** Harnessing-level reflection: `EXPERIENCE.md`, written only with real evidence. */
async function reflectStage(
	ctx: RunContext,
	opts: { label: string; base: Surface; adopted: Surface; signal?: AbortSignal },
): Promise<void> {
	const cfg = ctx.cfg;
	setStage(ctx.watch, "reflect");
	const diff = diffSurface(opts.base, opts.adopted);
	const composeNotes = readComposeNotes(ctx.runDir);
	const identity = assertIdentity(ctx.ledger);
	const record = [
		`${opts.label} adopted into the live tree`,
		`diff: added ${diff.added.length}, removed ${diff.removed.length}, modified ${diff.modified.length}, always-on Δ ${diff.alwaysOnDelta} chars`,
		`ledger: R ${identity.actual.R}/${identity.expected.R}, P ${identity.actual.P}/${identity.expected.P} (kept_base ${ctx.ledger.counters.keptBase}, fell_back ${ctx.ledger.counters.fellBack})`,
		`task: ${ctx.task}`,
	].join("\n");

	if (ctx.signal.aborted) {
		note(ctx, "reflection skipped: run interrupted");
		return;
	}
	if (outOfBudget(ctx)) {
		note(ctx, "reflection skipped: budget stop");
		return;
	}
	try {
		const mission = buildMission(
			"reflect",
			reflectParts(
				{ task: ctx.task, domain: ctx.domain, diffSummary: diffText("base vs adopted", diff), composeNotes, record },
				cfg,
			),
			cfg,
			ctx.runDir,
			"reflection",
		);
		recordBudget(ctx, "reflect", mission.mission.used);
		const run = await runEditor({
			stage: "reflect",
			mission: mission.mission,
			missionPath: mission.path,
			runDir: ctx.runDir,
			cfg,
			attempt: 0,
			fake: {
				stage: "reflect",
				domain: ctx.domain,
				skillName: `${ctx.domain}-notes`,
				baseAgents: opts.base["AGENTS.md"] ?? "",
			},
			signal: opts.signal,
		});
		addEntry(ctx.ledger, { kind: "reflection", label: "reflect", usd: run.usd, attempts: 1, wallMs: run.wallMs });
		save(ctx);

		const experience = parseExperience(run.reply);
		if (!experience) {
			note(ctx, "reflection wrote nothing: no lesson supported by the evidence (Harness² parity)");
			return;
		}
		const result = writeLessonIfValid(ctx.cwd, cfg, {
			domain: ctx.domain,
			slug: slugify(ctx.task),
			experience,
			label: opts.label,
		});
		if (result.written) note(ctx, `reflection written to library/${ctx.domain}/${slugify(ctx.task)}/EXPERIENCE.md`);
		else note(ctx, `reflection rejected: ${result.errors.join("; ")}`, "warn");
		if (result.superseded.length > 0) {
			note(
				ctx,
				`superseded older same-cue lesson(s): ${result.superseded.join(", ")} (kept on disk, no longer served)`,
			);
		}
	} catch (err) {
		if (err instanceof BudgetError) {
			note(ctx, `reflection skipped: ${err.message}`);
			return;
		}
		note(ctx, `reflection failed: ${(err as Error).message}`, "warn");
	}
}

function readComposeNotes(runDir: string): string[] {
	const dir = join(runDir, "notes");
	try {
		return listFiles(dir)
			.filter((f) => f.startsWith("final") || f.startsWith("inv") || f.startsWith("dom"))
			.map((f) => `${f.replace(/\.txt$/, "")}: ${readTextIf(join(dir, f)) ?? ""}`)
			.slice(0, 12);
	} catch {
		return [];
	}
}

interface FinishOptions {
	outcome: Outcome;
	chosen?: string | null;
	adopted?: boolean;
	errors?: boolean;
}

function finish(ctx: RunContext, opts: FinishOptions): LoopReport {
	ctx.ledger.outcome = opts.outcome;
	if (opts.outcome === "aborted")
		note(ctx, "run interrupted via /rsi-stop — nothing adopted, evidence kept under the run dir", "warn");
	if (opts.chosen !== undefined) ctx.ledger.chosen = opts.chosen;
	if (opts.adopted) ctx.ledger.adopted = true;
	save(ctx);

	const identity = assertIdentity(ctx.ledger);
	if (!identity.ok && opts.outcome === "adopted") {
		note(ctx, `identity mismatch: ${identity.problems.join("; ")}`, "error");
	}
	const status = renderStatus({ ledger: ctx.ledger, cfg: ctx.cfg });
	writeText(join(ctx.runDir, "status.txt"), `${status}\n`);
	writeText(
		join(ctx.runDir, "report.json"),
		JSON.stringify(
			{
				runId: ctx.runId,
				runDir: ctx.runDir,
				outcome: ctx.ledger.outcome,
				chosen: ctx.ledger.chosen,
				adopted: ctx.ledger.adopted,
				identity,
				usd: totalUsd(ctx.ledger),
				counters: ctx.ledger.counters,
				budgetsUsed: ctx.budgetsUsed,
				diversity: ctx.ledger.diversity,
				notes: ctx.ledger.notes,
				errors: ctx.errors,
			},
			null,
			"\t",
		),
	);

	endRun(ctx.watch.runId);
	ctx.releaseLock();
	return {
		runId: ctx.runId,
		runDir: ctx.runDir,
		outcome: ctx.ledger.outcome,
		chosen: ctx.ledger.chosen,
		adopted: ctx.ledger.adopted,
		identity,
		usd: totalUsd(ctx.ledger),
		status,
		notes: ctx.ledger.notes,
		errors: ctx.errors,
	};
}

// ---------------------------------------------------------------------------
// Command entry points used by index.ts
// ---------------------------------------------------------------------------

export interface CommandOptions {
	cwd: string;
	cfg: RsiConfig;
	io: LoopIO;
	runId?: string;
	label?: string;
	/** `--yes`: the user already confirmed (non-interactive adoption). */
	confirmed?: boolean;
	force?: boolean;
}

export interface CommandResult {
	ok: boolean;
	message: string;
	report?: LoopReport;
}

/** Latest run directory that has a ledger, or undefined. */
export function latestRunDir(cwd: string): string | undefined {
	const runId = latestRunId(cwd);
	return runId ? join(runsDir(cwd), runId) : undefined;
}

export function runDirFor(cwd: string, runId?: string): string | undefined {
	if (runId) {
		const dir = join(cwd, ".pi", "harness", "runs", runId);
		return loadLedger(dir) ? dir : undefined;
	}
	return latestRunDir(cwd);
}

/** `/rsi-status [runId]` — pure render of the persisted ledger. */
export function statusOfRun(opts: Pick<CommandOptions, "cwd" | "cfg" | "runId">): { ok: boolean; text: string } {
	const runDir = runDirFor(opts.cwd, opts.runId);
	if (!runDir) return { ok: false, text: "no rsi runs yet — start one with /rsi <task> or /rsi-probe <task>" };
	const ledger = loadLedger(runDir);
	if (!ledger) return { ok: false, text: `run ${runDir} has no readable ledger.json` };
	return { ok: true, text: renderStatus({ ledger, cfg: opts.cfg }) };
}

/** Status-bar headline for a rendered `/rsi-status` report (no line-index coupling). */
export function statusHeadline(text: string): string {
	return text.split("\n").find((line) => line.startsWith("outcome:")) ?? "rsi";
}

/**
 * `/rsi-adopt [label]` — the human gate as a command: apply a composed surface
 * from an earlier run to the live tree, snapshot it into the library, then
 * reflect. Fail-closed: the run's own validators run again before applying.
 */
export async function adoptCandidate(opts: CommandOptions): Promise<CommandResult> {
	const runDir = runDirFor(opts.cwd, opts.runId);
	if (!runDir) return { ok: false, message: "no rsi run found to adopt from" };
	const ledger = loadLedger(runDir);
	if (!ledger) return { ok: false, message: "run has no readable ledger.json" };

	const label = opts.label ?? ledger.chosen ?? "final0";
	const surfacePath = join(runDir, "surfaces", `${label}.json`);
	const raw = readTextIf(surfacePath);
	if (!raw) {
		const available = (() => {
			try {
				return listFiles(join(runDir, "surfaces"))
					.filter((f) => f.endsWith(".json"))
					.map((f) => f.replace(/\.json$/, ""));
			} catch {
				return [];
			}
		})();
		return {
			ok: false,
			message: `no snapshot for label "${label}" in ${runDir}/surfaces — available: ${available.join(", ") || "none"}`,
		};
	}

	let surface: Surface;
	try {
		surface = surfaceFromJson(raw);
	} catch (err) {
		return { ok: false, message: `snapshot unreadable: ${(err as Error).message}` };
	}

	const cfg = opts.cfg;
	const liveBefore = readSurface(opts.cwd, cfg);
	// Delta-only: adopting over a live tree that already carries an issue must
	// not be blocked by that pre-existing issue.
	const report = validate(surface, cfg, { where: label, base: liveBefore });
	if (report.errors.length > 0) {
		return { ok: false, message: `snapshot fails validation, not adopting:\n${report.errors.join("\n")}` };
	}

	const dirty = workingTreeStatus(opts.cwd);
	if (dirty.dirty && !opts.force) {
		return { ok: false, message: new DirtyTreeError(dirty.lines).message };
	}

	let confirmed = !cfg.confirmAdopt || opts.confirmed === true;
	if (!confirmed) {
		if (opts.io.confirmAdoption) {
			const scriptReview = renderScriptReview(liveBefore, surface);
			confirmed = await opts.io.confirmAdoption(
				`rsi: adopt ${label}?`,
				diffText(`adopt ${label}`, diffSurface(liveBefore, surface)) + (scriptReview ? `\n\n${scriptReview}` : ""),
			);
		} else {
			return { ok: false, message: `confirmation required (pass --yes) to adopt ${label}` };
		}
	}
	if (!confirmed) return { ok: false, message: `adoption of ${label} declined — live tree untouched` };

	const lock = acquireRunLock(opts.cwd, ledger.runId);
	if (!lock.ok) return { ok: false, message: new RunLockedError(lock.holder).message };

	const run = attachWatch({ runId: ledger.runId, runDir, task: ledger.task, domain: ledger.domain, kind: "adopt" });
	if (run.signal.aborted) {
		endRun(ledger.runId);
		lock.release();
		return { ok: false, message: "stop requested — adoption aborted before touching the live tree" };
	}
	const ctx: RunContext = {
		runId: ledger.runId,
		runDir,
		ledger,
		io: opts.io,
		cfg,
		cwd: opts.cwd,
		task: ledger.task,
		domain: ledger.domain,
		errors: [],
		budgetsUsed: ledger.budgetsUsed,
		watch: run.watch,
		signal: run.signal,
		clean: !dirty.dirty,
		releaseLock: lock.release,
	};
	writeSurface(opts.cwd, surface, { prune: true });
	adoptSurface(opts.cwd, cfg, { domain: ctx.domain, slug: slugify(ledger.task), liveBefore, adopted: surface });
	regenerateIndex(opts.cwd, cfg, ctx.domain);
	ctx.ledger.adopted = true;
	ctx.ledger.chosen = label;
	ctx.ledger.outcome = "adopted";
	save(ctx);
	note(ctx, `adopted ${label} via /rsi-adopt`, "success");

	await reflectStage(ctx, { label, base: liveBefore, adopted: surface, signal: ctx.signal });
	const finalReport = finish(ctx, { outcome: "adopted", chosen: label, adopted: true });
	return { ok: true, message: `adopted ${label}`, report: finalReport };
}
