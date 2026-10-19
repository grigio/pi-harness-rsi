/**
 * pi-harness-rsi — a pi extension for harness self-improvement with enforced
 * context economy (see README.md).
 *
 * One command, verb first:
 *
 *   /rsi                        state + next step (never runs a model)
 *   /rsi start  <task>          full loop: probe → propose → probe → compose → probe → select → adopt → reflect
 *   /rsi probe  <task>          reference executions + digests only (diagnostic, no edits)
 *   /rsi status [runId]         in-flight run, else the latest ledger
 *   /rsi watch                   live view of the in-flight run (polls; --once for a snapshot)
 *   /rsi stop                   interrupt the in-flight run
 *   /rsi adopt  [label]         human gate: apply a composed surface + write the library entry
 *   /rsi revert <domain>/<slug> restore the previous adopted surface
 *   /rsi library [domain]       browse domains, entries and INDEX.md
 *   /rsi help                   the verb table
 *
 * A line that does not start with a verb is a `start` task, so
 * `/rsi fix the flaky test` works. Flags must precede the task
 * (`/rsi start --k 2 fix the flaky test`); see src/args.ts.
 *
 * The extension proposes; the user adopts (P6). Every stage that enters a model
 * context is budgeted by `context.assemble()` and refuses to run over budget.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	flagBool,
	flagString,
	HELP,
	helpText,
	type ParsedCommand,
	parseCommand,
	usageOf,
	VERBS,
	type Verb,
} from "./src/args";
import { clampK, describeConfig, type RsiConfig, type RsiSettings, resolveConfig } from "./src/config";
import { loadLedger } from "./src/ledger";
import { entryDir, listDomains, listEntries, readExperience, readIndex, regenerateIndex } from "./src/library";
import { heldRunLock } from "./src/lock";
import {
	adoptCandidate,
	type LoopIO,
	latestRunDir,
	revertAdopted,
	runLoop,
	runReferenceProbes,
	statusHeadline,
	statusOfRun,
} from "./src/loop";
import { listRunIds } from "./src/runs";
import { truncateMiddle } from "./src/util";
import { getActiveRun, requestStop, runIsLive, watchSnapshot } from "./src/watch";

/** In print/headless mode there is no UI — mirror the text to stdout so
 * `pi --print "/rsi …"` stays observable instead of silently writing files. */
function echo(ctx: ExtensionCommandContext, text: string): void {
	try {
		if (!hasUI(ctx)) console.log(text);
	} catch {
		// hasUI is always available in real contexts; ignore stale-ctx probes
	}
}

function say(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
	notify(ctx, message, level);
	echo(ctx, message);
}

/**
 * UI calls are best-effort: a detached loop can outlive the command context it
 * was started from (pi replaces the ctx on session reload/switch and rejects
 * any later access with "This extension ctx is stale"). A throw from a footer
 * timer or a background notify is an uncaught exception that kills the whole
 * process — so every UI touch goes through here and degrades to a no-op.
 */
function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
	try {
		ctx.ui.notify(message, level);
	} catch {
		// stale ctx (session replaced) — the text still reached stdout via echo()
	}
}

function hasUI(ctx: ExtensionCommandContext): boolean {
	try {
		return ctx.hasUI;
	} catch {
		return false;
	}
}

/** Clear the footer entry (idempotent, safe on a stale ctx). */
function clearBar(ctx: ExtensionCommandContext): void {
	try {
		ctx.ui.setStatus("rsi", undefined);
	} catch {
		// stale ctx — nothing to clear
	}
}

/**
 * Footer text policy — every bar update answers the two questions the user has:
 * what rsi is doing right now, and what to do next. Idle states get just the
 * next step; active states pair "now" with the next action.
 */
function barText(now: string, next?: string): string {
	return next ? `rsi: ${now} — next: ${next}` : `rsi: ${now}`;
}

function setBar(
	ctx: { ui: { setStatus(key: string, text: string | undefined): void } },
	now: string,
	next?: string,
): void {
	try {
		ctx.ui.setStatus("rsi", barText(now, next));
	} catch {
		// stale ctx — never let a footer update throw out of a timer
	}
}

/** Braille spinner frames, cycled in the footer while an rsi loop is in flight. */
const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface FooterSpinner {
	/** Replace the text shown under the spinner frame (long stage messages do not stall the frame). */
	write(text: string): void;
	/** Stop cycling and set the final bar text (undefined clears the rsi status). */
	stop(final?: string): void;
}

/** The spinner of the loop that is currently running, so the dispatch-level error
 * boundary can always clear it — even when a loop throws instead of returning. */
let liveSpinner: FooterSpinner | undefined;

/**
 * Animated footer status: a braille frame in front of the latest rsi status text,
 * cycled by a timer, so a long-running loop visibly spins in the bar. UI-only:
 * in print/headless mode there is no footer, so it degrades to a plain setter.
 */
function startFooterSpinner(ctx: ExtensionCommandContext, initial: string): FooterSpinner {
	let base = initial;
	let frame = 0;
	const started = Date.now();
	/** Keep time visible so a long stage does not look stuck. */
	const elapsed = (): string => {
		const s = Math.floor((Date.now() - started) / 1000);
		return s < 90 ? `(${s}s)` : `(${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s)`;
	};
	const render = (): void => {
		try {
			if (hasUI(ctx))
				ctx.ui.setStatus(
					"rsi",
					`${SPIN_FRAMES[frame++ % SPIN_FRAMES.length]} ${truncateMiddle(base, 100)} ${elapsed()}`,
				);
		} catch {
			// The session was replaced/reloaded while the loop ran: stop animating
			// rather than throwing out of a timer (uncaught → process exit).
			clearInterval(timer);
			if (liveSpinner === spinner) liveSpinner = undefined;
		}
	};
	render();
	const timer = setInterval(render, 110);
	const spinner: FooterSpinner = {
		write(text: string): void {
			base = text.replace(/\s+/g, " ");
			render();
		},
		stop(final?: string): void {
			clearInterval(timer);
			if (liveSpinner === spinner) liveSpinner = undefined;
			try {
				ctx.ui.setStatus("rsi", final); // undefined clears the entry
			} catch {
				// stale ctx — nothing to clear
			}
		},
	};
	// Do not keep the process alive just for the animation (headless workers).
	(timer as { unref?(): void }).unref?.();
	liveSpinner = spinner;
	return spinner;
}

function makeIO(ctx: ExtensionCommandContext, spinner?: FooterSpinner): LoopIO {
	return {
		log(message: string, level = "info"): void {
			const text = truncateMiddle(message.replace(/\s+/g, " "), 110);
			if (spinner) spinner.write(text);
			else setBar(ctx, text);
			if (level === "info") {
				echo(ctx, `[rsi] ${message}`);
				return;
			}
			say(ctx, message, level === "success" ? "info" : level === "warn" ? "warning" : "error");
		},
		async confirmAdoption(title: string, message: string): Promise<boolean> {
			if (!hasUI(ctx)) {
				// Headless runs cannot confirm — keep the P6 gate closed and let
				// `/rsi adopt --yes` do the explicit adoption later.
				echo(ctx, `${title}\n${message}`);
				return false;
			}
			return ctx.ui.confirm(title, message);
		},
	};
}

export default function rsiExtension(pi: ExtensionAPI): void {
	const configOf = (): RsiConfig => {
		const settings = pi.getSettings() as unknown as { rsi?: RsiSettings };
		return resolveConfig(settings?.rsi);
	};

	pi.registerCommand("rsi", {
		description:
			"Harness self-improvement: start | probe | status | watch | stop | adopt | revert | library | help (bare /rsi shows state)",
		getArgumentCompletions: (prefix: string) => {
			if (!prefix.includes(" ")) {
				const wanted = prefix.trim().toLowerCase();
				return VERBS.filter((v) => v.startsWith(wanted)).map((v) => ({ value: v, label: `${v} — ${HELP[v].summary}` }));
			}
			const verb = prefix.trim().split(/\s+/)[0];
			const last = prefix.trim().split(/\s+/).pop() ?? "";
			if (verb === "adopt") {
				return labelsOf(process.cwd())
					.filter((l) => l.startsWith(last))
					.map((l) => ({ value: `adopt ${l}`, label: l }));
			}
			if (verb === "status") {
				return listRunIds(process.cwd())
					.filter((id) => id.startsWith(last))
					.map((id) => ({ value: `status ${id}`, label: id }));
			}
			if (verb === "library" || verb === "revert") {
				return listDomains(process.cwd(), configOf())
					.filter((d) => d.startsWith(last))
					.map((d) => ({ value: `${verb} ${d}`, label: d }));
			}
			return null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const cfg = configOf();
			// Matched conditions: unless a model is configured explicitly, child
			// runs inherit the model this session is actually using — not the
			// settings default, which can differ from what `/model` selected.
			inheritModel(cfg, ctx);
			const cmd = parseCommand(args);

			if (cmd.errors.length > 0) {
				const verb = cmd.verb ?? "start";
				say(ctx, `rsi: ${cmd.errors.join("\n")}\n${usageOf(verb)}`, "warning");
				return;
			}

			// No verb + no text → the state view (the "what do I do next" entry point).
			const verb: Verb = cmd.verb ?? (cmd.text.length > 0 ? "start" : "status");

			// One error boundary for the whole command surface: run-level failures
			// (`RunLockedError`, a dirty tree, a disk error) must reach the user as a
			// message, not escape the extension as an unhandled rejection.
			const work = (): Promise<void> => dispatch(verb, cfg, cmd, ctx);
			// Long-running verbs must not block the handler. Pi queues typed input
			// while a command handler is awaited (the interactive loop only returns to
			// `getUserInput` once `session.prompt` resolves), so a synchronous
			// `/rsi start` makes its own `/rsi stop` undeliverable until the run has
			// already ended — the exact "stop does nothing" report. Detach and let the
			// input loop keep accepting commands.
			//
			// Headless is the opposite: `pi --print "/rsi probe …"` exits as soon as
			// the handler resolves, so detaching abandoned the loop before it ran a
			// single rollout and left a phantom `outcome: running` ledger behind.
			// There is no input loop to keep responsive, so await the work there.
			if (isLongRunning(verb, cmd) && hasUI(ctx)) {
				background(verb, ctx, work);
				return;
			}
			try {
				await work();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				say(ctx, `rsi ${verb}: ${message}`, "error");
				liveSpinner?.stop(); // a thrown loop must not leave the frame cycling
				clearBar(ctx);
			}
		},
	});

	// Surface a pending adoption at startup (cheap, file-only, no model call).
	pi.on("session_start", (_event, ctx) => {
		try {
			const hint = nextStep(ctx.cwd);
			if (hint) setBar(ctx, "idle, nothing in flight", hint);
		} catch {
			// never block startup on rsi diagnostics
		}
	});
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

/**
 * Verbs that can run for minutes (whole-loop `start`/`probe`, or the live
 * `watch` tail) must run detached from the command handler; see the handler.
 * Interactive verbs (adopt/library/status) stay awaited so their pickers and
 * editors do not race the input loop.
 */
function isLongRunning(verb: Verb, cmd: ParsedCommand): boolean {
	if (verb === "start" || verb === "probe") return true;
	return verb === "watch" && !flagBool(cmd, "once");
}

/** Detached work with the same error boundary the awaited path uses. */
function background(verb: Verb, ctx: ExtensionCommandContext, work: () => Promise<void>): void {
	void work().catch((err) => {
		const message = err instanceof Error ? err.message : String(err);
		say(ctx, `rsi ${verb}: ${message}`, "error");
		liveSpinner?.stop(); // a thrown loop must not leave the frame cycling
		clearBar(ctx);
	});
}

async function dispatch(verb: Verb, cfg: RsiConfig, cmd: ParsedCommand, ctx: ExtensionCommandContext): Promise<void> {
	switch (verb) {
		case "help":
			say(ctx, helpText(), "info");
			return;
		case "start":
			await runStart(cfg, cmd, ctx);
			return;
		case "probe":
			await runProbe(cfg, cmd, ctx);
			return;
		case "status":
			await showStatus(cfg, cmd, ctx);
			return;
		case "watch":
			await watch(cmd, ctx);
			return;
		case "stop":
			stop(ctx);
			return;
		case "adopt":
			await adopt(cfg, cmd, ctx);
			return;
		case "revert":
			await revert(cfg, cmd, ctx);
			return;
		case "library":
			await library(cfg, cmd, ctx);
			return;
		default: {
			// Exhaustiveness: a new Verb with no case here is a compile error,
			// not a command that silently does nothing.
			const unreachable: never = verb;
			throw new Error(`rsi: unhandled verb ${String(unreachable)}`);
		}
	}
}

async function runStart(cfg: RsiConfig, cmd: ParsedCommand, ctx: ExtensionCommandContext): Promise<void> {
	const task = cmd.text;
	if (!task) {
		say(ctx, usageOf("start"), "warning");
		return;
	}
	const kFlag = flagString(cmd, "k");
	if (kFlag) cfg.k = setK(ctx, kFlag);
	const mode = flagString(cmd, "mode");
	if (mode === "sequential" || mode === "parallel") cfg.mode = mode;
	else if (mode) {
		say(ctx, `rsi: --mode must be "parallel" or "sequential" (got "${mode}")`, "warning");
		return;
	}
	const domain = flagString(cmd, "domain") ?? inferDomain(task, ctx.cwd);
	const force = flagBool(cmd, "force");
	if (flagBool(cmd, "yes")) cfg.confirmAdopt = false;

	if (refuseWhenBusy(ctx, "start")) return;

	say(ctx, `rsi: ${describeConfig(cfg)} — task "${truncateMiddle(task, 80)}"`, "info");
	const spinner = startFooterSpinner(ctx, `run: ${task}`);
	const report = await runLoop({ cfg, cwd: ctx.cwd, task, domain, force, io: makeIO(ctx, spinner) });
	const hint = nextStep(ctx.cwd);
	spinner.stop(barText(`run ${report.runId}: ${report.outcome}${report.chosen ? ` (${report.chosen})` : ""}`, hint));
	echo(ctx, report.status);
	say(
		ctx,
		`rsi ${report.runId}: ${report.outcome} · USD ${report.usd.toFixed(4)} · R ${report.identity.actual.R}/${report.identity.expected.R} P ${report.identity.actual.P}/${report.identity.expected.P}`,
		report.outcome === "error" ? "error" : "info",
	);
	if (hint) say(ctx, hint, "info");
}

async function runProbe(cfg: RsiConfig, cmd: ParsedCommand, ctx: ExtensionCommandContext): Promise<void> {
	const task = cmd.text;
	if (!task) {
		say(ctx, usageOf("probe"), "warning");
		return;
	}
	const kFlag = flagString(cmd, "k");
	if (kFlag) cfg.k = setK(ctx, kFlag);
	if (refuseWhenBusy(ctx, "probe")) return;
	const spinner = startFooterSpinner(ctx, `probe: ${task}`);
	const report = await runReferenceProbes({
		cfg,
		cwd: ctx.cwd,
		task,
		domain: flagString(cmd, "domain") ?? inferDomain(task, ctx.cwd),
		io: makeIO(ctx, spinner),
		force: true,
	});
	say(ctx, `rsi-probe ${report.runId}: ${report.outcome} · digests in ${report.runDir}/digests`, "info");
	echo(ctx, report.status);
	const hint = nextStep(ctx.cwd);
	spinner.stop(barText(`probe ${report.runId}: ${report.outcome}`, hint));
	if (hint) say(ctx, hint, "info");
}

async function showStatus(cfg: RsiConfig, cmd: ParsedCommand, ctx: ExtensionCommandContext): Promise<void> {
	// `watchSnapshot` sees both this session's registry and a run started in
	// another session (ledger disk view), so `/rsi status` is not blind to a
	// headless run the way a registry-only check would be.
	const snap = watchSnapshot(ctx.cwd, 12);
	if (snap.active && snap.runId && !cmd.positional[0]) {
		setBar(ctx, `run ${snap.runId} in flight (${snap.stage})`, "/rsi watch · /rsi stop");
		if (hasUI(ctx)) {
			await ctx.ui.editor(`rsi status (${snap.runId}, in flight)`, `${snap.text}\n\nnext: /rsi watch   ·   /rsi stop`);
			return;
		}
		console.log(`${snap.text}\n\nnext: /rsi watch   ·   /rsi stop`);
		return;
	}

	const runId = cmd.positional[0];
	const result = statusOfRun({ cwd: ctx.cwd, cfg, runId });
	if (!result.ok) {
		say(ctx, result.text, "warning");
		setBar(ctx, "no run to report", "/rsi start <task> — /rsi help");
		return;
	}
	const hint = nextStep(ctx.cwd);
	const text = hint ? `${result.text}\n\nnext: ${hint}` : result.text;
	setBar(ctx, statusHeadline(result.text), hint);
	// Bare `/rsi status` (no run id needed) reports the current situation inline —
	// the latest run's ledger plus the suggested next step — instead of opening
	// a modal editor. `/rsi status <runId>` still targets a specific run.
	say(ctx, text, "info");
}

async function watch(cmd: ParsedCommand, ctx: ExtensionCommandContext): Promise<void> {
	const lines = Math.max(1, Math.min(50, Number(flagString(cmd, "lines")) || 12));
	// `watch` is live by default — that is what the verb means. `--once` (and the
	// legacy `--follow` flag, now a no-op) gets the old one-shot snapshot.
	if (flagBool(cmd, "once")) {
		const snap = watchSnapshot(ctx.cwd, lines);
		if (snap.active) {
			setBar(ctx, "run in flight", "/rsi stop interrupts it");
			if (hasUI(ctx)) notify(ctx, snap.text, "info");
			echo(ctx, snap.text);
		} else {
			clearBar(ctx);
			say(ctx, snap.text, "info");
		}
		return;
	}
	// Live: poll every 2s and print new notes as they land. Reads
	// `watchSnapshot`, so it follows a run owned by another session/headless
	// process too (the disk view), not just this process's live registry.
	// In the TUI `echo` is a no-op, so surface lines through `notify` as well.
	const emit = (text: string): void => {
		if (hasUI(ctx)) notify(ctx, text, "info");
		echo(ctx, text);
	};
	emit("rsi: watching the in-flight run (poll 2s) — /rsi stop interrupts it; /rsi watch --once for a snapshot");
	let lastRunId: string | undefined;
	let seen = 0;
	const deadline = Date.now() + 2 * 60 * 60 * 1000; // hard cap: 2h
	for (;;) {
		if (Date.now() >= deadline) {
			emit("rsi: watch deadline reached (2h) — /rsi watch resumes");
			return;
		}
		const snap = watchSnapshot(ctx.cwd, lines);
		if (!snap.active || !snap.runId) {
			emit(lastRunId !== undefined ? `rsi: run ${lastRunId} closed` : "rsi: no run in flight");
			return;
		}
		if (snap.runId !== lastRunId) {
			lastRunId = snap.runId;
			emit(snap.text);
			seen = snap.notes.length;
		} else {
			for (const note of snap.notes.slice(seen)) emit(`  [${snap.stage}] ${note}`);
			seen = snap.notes.length;
			setBar(ctx, `watch ${snap.runId}: ${snap.stage}`, "/rsi stop interrupts it");
			if (snap.stopped) {
				await sleepMs(2000); // give the loop a beat to unwind and write the ledger
				emit(watchSnapshot(ctx.cwd, lines).text);
				return;
			}
		}
		await sleepMs(2000);
	}
}

function stop(ctx: ExtensionCommandContext): void {
	const result = requestStop(ctx.cwd);
	say(ctx, `rsi: ${result.message}`, result.ok ? "warning" : "info");
	if (result.ok) setBar(ctx, "stop requested — the run unwinds at its next stage boundary", "/rsi status");
}

async function adopt(cfg: RsiConfig, cmd: ParsedCommand, ctx: ExtensionCommandContext): Promise<void> {
	if (refuseWhenBusy(ctx, "adopt")) return;
	const spinner = startFooterSpinner(ctx, `adopt: ${cmd.positional[0] ?? "latest candidate"}`);
	const result = await adoptCandidate({
		cwd: ctx.cwd,
		cfg,
		io: makeIO(ctx, spinner),
		runId: flagString(cmd, "run"),
		label: cmd.positional[0],
		confirmed: flagBool(cmd, "yes"),
		force: flagBool(cmd, "force"),
	});
	say(ctx, result.ok ? `rsi: ${result.message}` : `rsi adopt failed: ${result.message}`, result.ok ? "info" : "error");
	if (result.ok) {
		const hint = nextStep(ctx.cwd);
		spinner.stop(barText(`adopted ${result.message}`, hint));
		if (hint) say(ctx, hint, "info");
	} else {
		spinner.stop(barText(`adopt failed: ${result.message}`, "/rsi status"));
	}
}

async function revert(cfg: RsiConfig, cmd: ParsedCommand, ctx: ExtensionCommandContext): Promise<void> {
	const [first, second] = cmd.positional;
	// Accept `<domain>/<slug>` (documented), `--domain`-less `<domain> <slug>`, and
	// the library's own slug form (slugs are already `slugify`-ed on write).
	const domain = second ? first : first?.split("/")[0];
	const rawSlug = second ?? first?.split("/").slice(1).join("/");
	if (!domain || !rawSlug) {
		say(ctx, `${usageOf("revert")}\n  e.g. /rsi revert acme-api add-a-rate-limit-header`, "warning");
		return;
	}
	if (refuseWhenBusy(ctx, "revert")) return;
	const result = await revertAdopted({
		cwd: ctx.cwd,
		cfg,
		force: flagBool(cmd, "force"),
		domain,
		slug: rawSlug,
	});
	say(ctx, result.ok ? `rsi: ${result.message}` : `rsi revert: ${result.message}`, result.ok ? "info" : "warning");
	if (result.ok) setBar(ctx, result.message, nextStep(ctx.cwd));
}

async function library(cfg: RsiConfig, cmd: ParsedCommand, ctx: ExtensionCommandContext): Promise<void> {
	const domains = listDomains(ctx.cwd, cfg);
	if (domains.length === 0) {
		say(ctx, "rsi library is empty — adopt a run with /rsi adopt first", "info");
		return;
	}
	const wanted = cmd.positional[0];
	if (wanted && !domains.includes(wanted)) {
		say(ctx, `rsi library: no domain "${wanted}" — known: ${domains.join(", ")}`, "warning");
		return;
	}
	const domain = wanted ?? (hasUI(ctx) ? await ctx.ui.select("rsi library: domain", domains) : domains[0]);
	if (!domain) return;
	regenerateIndex(ctx.cwd, cfg, domain);
	const entries = listEntries(ctx.cwd, cfg, domain);
	const index = readIndex(ctx.cwd, cfg, domain) ?? "";
	const items = [
		"--- INDEX.md ---",
		index.trim(),
		"--- entries ---",
		...entries.map((e) => `${e.slug}  ·  ${e.cue}${e.superseded ? `  ·  (superseded ${e.superseded})` : ""}`),
	];
	if (!hasUI(ctx)) {
		console.log(items.join("\n")); // headless: dump the index instead of prompting
		return;
	}
	const picked = await ctx.ui.select(`rsi library: ${domain}`, [...entries.map((e) => e.slug), "(view INDEX only)"]);
	if (!picked || picked === "(view INDEX only)") {
		await ctx.ui.editor(`${domain}/INDEX.md`, items.join("\n"));
		return;
	}
	// Read *this* entry: `loadLessons` is a retrieval function (top-≤3 by cue
	// overlap), so passing the picked slug as a task displayed whichever entry
	// happened to score best instead of the one the user selected.
	const entry = entries.find((e) => e.slug === picked);
	const exp = readExperience(entryDir(ctx.cwd, cfg, domain, picked));
	const body = exp
		? [
				`### ${picked}`,
				`cue: ${exp.cue}`,
				`lesson: ${exp.lesson}`,
				`evidence: ${exp.evidence}`,
				`confidence: ${exp.confidence}`,
				...(exp.adoptedAt ? [`adopted: ${exp.adoptedAt}`] : []),
				...(exp.superseded ? [`superseded: ${exp.superseded}`] : []),
			].join("\n")
		: `(no readable EXPERIENCE.md for ${picked})`;
	await ctx.ui.editor(`${domain}/${picked}/EXPERIENCE.md`, entry ? body : items.join("\n"));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parent model as `provider/id`, for child runs that have no explicit override. */
function inheritModel(cfg: RsiConfig, ctx: ExtensionCommandContext): void {
	if (cfg.solverModel && cfg.editorModel) return;
	let model: { provider?: string; id?: string } | undefined;
	try {
		model = ctx.model as { provider?: string; id?: string } | undefined;
	} catch {
		return; // stale ctx
	}
	if (!model?.provider || !model.id) return;
	const ref = `${model.provider}/${model.id}`;
	if (!cfg.solverModel) cfg.solverModel = ref;
	if (!cfg.editorModel) cfg.editorModel = ref;
}

function sleepMs(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shared "one run at a time" guard for the verbs that start or apply a run. */
function refuseWhenBusy(ctx: ExtensionCommandContext, verb: Verb): boolean {
	const flight = getActiveRun();
	if (flight) {
		say(
			ctx,
			`rsi ${verb}: run ${flight.runId} is still in flight (stage "${flight.stage}") — /rsi stop interrupts it, or wait for it to end`,
			"warning",
		);
		return true;
	}
	const foreign = heldRunLock(ctx.cwd);
	if (foreign) {
		say(
			ctx,
			`rsi ${verb}: run ${foreign.runId} is in flight in another session (pid ${foreign.pid}) — wait for it to end`,
			"warning",
		);
		return true;
	}
	return false;
}

/**
 * The single "what next" hint: every command that changes state ends by
 * printing exactly one command to type next.
 */
function nextStep(cwd: string): string | undefined {
	const flight = getActiveRun();
	if (flight) return `/rsi watch   ·   /rsi stop`;
	for (const runId of listRunIds(cwd)) {
		const ledger = loadLedger(join(cwd, ".pi", "harness", "runs", runId));
		if (!ledger) continue;
		if (ledger.outcome === "pending" && ledger.chosen) {
			return `/rsi adopt ${ledger.chosen} --run ${runId}`;
		}
		if (ledger.outcome === "no_change") {
			return `/rsi status ${runId}   ·   /rsi start <task> (nothing changed — try another task or profile)`;
		}
		if (ledger.outcome === "running") {
			// A phantom run (owner gone) has no next step of its own: point at a
			// fresh start instead of a `/rsi status` that only says it died.
			if (!runIsLive(ledger, cwd)) return `/rsi start <task> (run ${runId} died — evidence kept, nothing adopted)`;
			return `/rsi status ${runId}`;
		}
		if (ledger.outcome === "adopted") return `/rsi library ${ledger.domain}`;
		if (ledger.outcome === "probed") return `/rsi start <task>   ·   /rsi status ${runId}`;
		return `/rsi status ${runId}`;
	}
	return undefined;
}

/** Path roots that carry no domain meaning — a task touching `src/x.ts` must
 * not create a `src` domain that then collides with every other source task. */
const NON_DOMAIN_ROOTS = new Set([
	"src",
	"lib",
	"app",
	"apps",
	"packages",
	"test",
	"tests",
	"spec",
	"docs",
	"scripts",
	"node_modules",
	".",
	"..",
]);

function inferDomain(task: string, cwd: string): string {
	const repo = cwd.split("/").filter(Boolean).pop() ?? "default";
	const pathToken = task.match(/(?:^|\s)((?:[\w.-]+\/)+[\w.-]+)/)?.[1];
	if (pathToken) {
		const first = pathToken.split("/")[0];
		if (first && first.length > 2 && !NON_DOMAIN_ROOTS.has(first.toLowerCase())) return first;
	}
	return repo;
}

function setK(ctx: ExtensionCommandContext, raw: string): number {
	const wanted = Math.max(1, Math.floor(Number(raw) || 1));
	const clamped = clampK(wanted);
	if (wanted !== clamped) say(ctx, `rsi: --k ${wanted} capped to ${clamped} (concurrency/run-cost guard)`, "warning");
	return clamped;
}

function labelsOf(cwd: string): string[] {
	const dir = latestRunDir(cwd);
	if (!dir) return [];
	try {
		return readdirSync(join(dir, "surfaces"))
			.filter((f) => f.endsWith(".json"))
			.map((f) => f.replace(/\.json$/, ""))
			.sort();
	} catch {
		return [];
	}
}
