/**
 * pi-harness-rsi — a pi extension for harness self-improvement with enforced
 * context economy (see README.md).
 *
 * Commands:
 *   /rsi <task>            full loop: probe → propose → probe → compose → probe → select → adopt → reflect
 *   /rsi-probe <task>      reference executions + digests only (diagnostic, no edits)
 *   /rsi-status [runId]    ledger (R=4k, P=3k), USD, fallbacks, diversity, budget usage
 *   /rsi-adopt [label]     human gate: apply a composed surface + write the library entry
 *   /rsi-revert [domain/slug]  restore the previous adopted surface
 *   /rsi-library [domain]  browse domains, entries and INDEX.md
 *
 * The extension proposes; the user adopts (P6). Every stage that enters a model
 * context is budgeted by `context.assemble()` and refuses to run over budget.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { clampK, describeConfig, type RsiConfig, type RsiSettings, resolveConfig } from "./src/config";
import { loadLedger } from "./src/ledger";
import { listDomains, listEntries, loadLessons, readIndex, regenerateIndex, revertSurface } from "./src/library";
import { heldRunLock } from "./src/lock";
import {
	adoptCandidate,
	type LoopIO,
	latestRunDir,
	runLoop,
	runReferenceProbes,
	statusHeadline,
	statusOfRun,
} from "./src/loop";
import { listRunIds } from "./src/runs";
import { truncateMiddle } from "./src/util";
import { getActiveRun, renderWatch, requestStop } from "./src/watch";

interface ParsedArgs {
	flags: Map<string, string | boolean>;
	positional: string[];
}

/** Tiny `--flag value` / `--bool` parser (no shell, no deps). */
function parseArgs(raw: string): ParsedArgs {
	const flags = new Map<string, string | boolean>();
	const positional: string[] = [];
	const tokens = raw.trim().length > 0 ? raw.trim().split(/\s+/) : [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.startsWith("--")) {
			const name = token.slice(2);
			const next = tokens[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags.set(name, next);
				i++;
			} else {
				flags.set(name, true);
			}
		} else {
			positional.push(token);
		}
	}
	return { flags, positional };
}

/** In print/headless mode there is no UI — mirror the text to stdout so
 * `pi --print "/rsi …"` stays observable instead of silently writing files. */
function echo(ctx: ExtensionCommandContext, text: string): void {
	try {
		if (!ctx.hasUI) console.log(text);
	} catch {
		// hasUI is always available in real contexts; ignore stale-ctx probes
	}
}

function say(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
	ctx.ui.notify(message, level);
	echo(ctx, message);
}

function makeIO(ctx: ExtensionCommandContext): LoopIO {
	return {
		log(message: string, level = "info"): void {
			ctx.ui.setStatus("rsi", truncateMiddle(message.replace(/\s+/g, " "), 110));
			if (level === "info") {
				echo(ctx, `[rsi] ${message}`);
				return;
			}
			say(ctx, message, level === "success" ? "info" : level === "warn" ? "warning" : "error");
		},
		async confirmAdoption(title: string, message: string): Promise<boolean> {
			if (!ctx.hasUI) {
				// Headless runs cannot confirm — keep the P6 gate closed and let
				// /rsi-adopt --yes do the explicit adoption later.
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

	const str = (flags: Map<string, string | boolean>, name: string): string | undefined => {
		const v = flags.get(name);
		return typeof v === "string" ? v : undefined;
	};

	pi.registerCommand("rsi", {
		description: "Run the harness self-improvement loop for a task (probe → propose → compose → adopt → reflect)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const cfg = configOf();
			const parsed = parseArgs(args);
			const task = parsed.positional.join(" ").trim();
			if (!task) {
				say(
					ctx,
					"usage: /rsi [--domain <name>] [--k <n>] [--mode parallel|sequential] [--force] [--yes] <task>",
					"warning",
				);
				return;
			}
			const kFlag = str(parsed.flags, "k");
			if (kFlag) cfg.k = setK(ctx, kFlag);
			const mode = str(parsed.flags, "mode");
			if (mode === "sequential" || mode === "parallel") cfg.mode = mode;
			const domain = str(parsed.flags, "domain") ?? inferDomain(task, ctx.cwd);
			const force = parsed.flags.get("force") === true;
			const yes = parsed.flags.get("yes") === true;
			if (yes) cfg.confirmAdopt = false;

			const flight = getActiveRun();
			if (flight) {
				say(
					ctx,
					`rsi: run ${flight.runId} is still in flight (stage "${flight.stage}") — /rsi-stop interrupts it, or wait for it to end`,
					"warning",
				);
				return;
			}
			const foreign = heldRunLock(ctx.cwd);
			if (foreign) {
				say(
					ctx,
					`rsi: run ${foreign.runId} is in flight in another session (pid ${foreign.pid}) — wait for it to end`,
					"warning",
				);
				return;
			}

			say(ctx, `rsi: ${describeConfig(cfg)} — task "${truncateMiddle(task, 80)}"`, "info");
			const report = await runLoop({
				cfg,
				cwd: ctx.cwd,
				task,
				domain,
				force,
				io: makeIO(ctx),
			});
			ctx.ui.setStatus("rsi", `run ${report.runId}: ${report.outcome}${report.chosen ? ` (${report.chosen})` : ""}`);
			echo(ctx, report.status); // full ledger render for headless runs
			say(
				ctx,
				`rsi ${report.runId}: ${report.outcome} · USD ${report.usd.toFixed(4)} · R ${report.identity.actual.R}/${report.identity.expected.R} P ${report.identity.actual.P}/${report.identity.expected.P}`,
				report.outcome === "error" ? "error" : "info",
			);
			if (report.outcome === "pending" && report.chosen) {
				say(ctx, `/rsi-adopt ${report.chosen} to apply it to the working tree`, "info");
			}
		},
	});

	pi.registerCommand("rsi-probe", {
		description: "Reference executions and digests only (no edits, no editor)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const cfg = configOf();
			const parsed = parseArgs(args);
			const task = parsed.positional.join(" ").trim();
			if (!task) {
				say(ctx, "usage: /rsi-probe [--k <n>] [--domain <name>] <task>", "warning");
				return;
			}
			const kFlag = str(parsed.flags, "k");
			if (kFlag) cfg.k = setK(ctx, kFlag);
			const flight = getActiveRun();
			if (flight) {
				say(
					ctx,
					`rsi-probe: run ${flight.runId} is still in flight (stage "${flight.stage}") — wait for it or /rsi-stop it`,
					"warning",
				);
				return;
			}
			const foreign = heldRunLock(ctx.cwd);
			if (foreign) {
				say(
					ctx,
					`rsi-probe: run ${foreign.runId} is in flight in another session (pid ${foreign.pid}) — wait for it to end`,
					"warning",
				);
				return;
			}
			const report = await runReferenceProbes({
				cfg,
				cwd: ctx.cwd,
				task,
				domain: str(parsed.flags, "domain") ?? inferDomain(task, ctx.cwd),
				io: makeIO(ctx),
				force: true,
			});
			ctx.ui.notify(`rsi-probe ${report.runId}: ${report.outcome} · digests in ${report.runDir}/digests`, "info");
			echo(ctx, report.status);
		},
	});

	pi.registerCommand("rsi-status", {
		description: "Ledger identity (R=4k, P=3k), USD, fallback counts, diversity, budget usage",
		getArgumentCompletions: (prefix: string) =>
			allRunIds(process.cwd())
				.filter((id) => id.startsWith(prefix))
				.map((id) => ({ value: id, label: id })),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const cfg = configOf();
			const runId = args.trim().split(/\s+/)[0] || undefined;
			const result = statusOfRun({ cwd: ctx.cwd, cfg, runId });
			if (!result.ok) {
				say(ctx, result.text, "warning");
				ctx.ui.setStatus("rsi", undefined);
				return;
			}
			const pending = pendingInfo(ctx.cwd);
			ctx.ui.setStatus("rsi", pending ? `pending adoption: ${pending.label}` : statusHeadline(result.text));
			if (!ctx.hasUI) {
				console.log(result.text); // headless: print instead of opening the editor
				return;
			}
			// Full report goes through the editor so long output stays readable.
			const shown = await ctx.ui.editor(`rsi-status ${runId ?? "(latest)"}`, result.text);
			void shown;
		},
	});

	pi.registerCommand("rsi-adopt", {
		description: "Adopt a composed surface from the latest (or named) run into the live tree",
		getArgumentCompletions: (prefix: string) =>
			labelsOf(process.cwd(), undefined)
				.filter((l) => l.startsWith(prefix))
				.map((l) => ({ value: l, label: l })),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const cfg = configOf();
			const parsed = parseArgs(args);
			const confirmed = parsed.flags.get("yes") === true;
			const force = parsed.flags.get("force") === true;
			const runId = str(parsed.flags, "run");
			const label = parsed.positional[0];
			const flight = getActiveRun();
			if (flight) {
				say(
					ctx,
					`rsi-adopt: run ${flight.runId} is still in flight — adopting mid-run would change the tree under its probes; /rsi-stop it first`,
					"warning",
				);
				return;
			}
			const foreign = heldRunLock(ctx.cwd);
			if (foreign) {
				say(
					ctx,
					`rsi-adopt: run ${foreign.runId} is in flight in another session (pid ${foreign.pid}) — wait for it to end`,
					"warning",
				);
				return;
			}
			const result = await adoptCandidate({
				cwd: ctx.cwd,
				cfg,
				io: makeIO(ctx),
				runId,
				label,
				confirmed,
				force,
			});
			say(
				ctx,
				result.ok ? `rsi: ${result.message}` : `rsi-adopt failed: ${result.message}`,
				result.ok ? "info" : "error",
			);
		},
	});

	pi.registerCommand("rsi-revert", {
		description: "Restore the previous adopted surface from the library",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const cfg = configOf();
			const [domainArg, slugArg] = args
				.trim()
				.split(/\s+/)
				.filter((s) => s.length > 0);
			const result = revertSurface(ctx.cwd, cfg, { domain: domainArg, slug: slugArg });
			say(
				ctx,
				result.ok ? `rsi: ${result.message} (${result.restored})` : `rsi-revert: ${result.message}`,
				result.ok ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("rsi-library", {
		description: "List library domains and entries, open an INDEX.md or EXPERIENCE.md",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const cfg = configOf();
			const domains = listDomains(ctx.cwd, cfg);
			if (domains.length === 0) {
				say(ctx, "rsi library is empty — adopt a run with /rsi-adopt first", "info");
				return;
			}
			const wanted = args.trim().split(/\s+/)[0];
			const domain =
				wanted && domains.includes(wanted)
					? wanted
					: ctx.hasUI
						? await ctx.ui.select("rsi library: domain", domains)
						: domains[0];
			if (!domain) return;
			regenerateIndex(ctx.cwd, cfg, domain);
			const entries = listEntries(ctx.cwd, cfg, domain);
			const index = readIndex(ctx.cwd, cfg, domain) ?? "";
			const items = [
				"--- INDEX.md ---",
				index.trim(),
				"--- entries ---",
				...entries.map((e) => `${e.slug}  ·  ${e.cue}`),
			];
			if (!ctx.hasUI) {
				console.log(items.join("\n")); // headless: dump the index instead of prompting
				return;
			}
			const picked = await ctx.ui.select(`rsi library: ${domain}`, [
				...entries.map((e) => e.slug),
				"(view INDEX only)",
			]);
			if (!picked || picked === "(view INDEX only)") {
				await ctx.ui.editor(`${domain}/INDEX.md`, items.join("\n"));
				return;
			}
			const lessons = loadLessons(ctx.cwd, cfg, domain, picked, 1);
			await ctx.ui.editor(`${domain}/${picked}/EXPERIENCE.md`, lessons.lessons.join("\n\n") || items.join("\n"));
		},
	});

	// Live inspection + interruption of the in-flight run (see src/watch.ts).
	pi.registerCommand("rsi-watch", {
		description: "Live view of the in-flight rsi run: stage, USD, latest notes; --follow tails it until it closes",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parsed = parseArgs(args);
			const lines = Math.max(1, Math.min(50, Number(str(parsed.flags, "lines")) || 12));
			const follow = parsed.flags.get("follow") === true;
			if (!follow) {
				const snap = renderWatch(ctx.cwd, lines);
				if (snap.active) {
					ctx.ui.setStatus("rsi", `watching run in flight — /rsi-stop interrupts`);
					if (ctx.hasUI) ctx.ui.notify(snap.text, "info");
					echo(ctx, snap.text);
				} else {
					ctx.ui.setStatus("rsi", undefined);
					say(ctx, snap.text, "info");
				}
				return;
			}
			// --follow: poll every 2s; print new notes as they land (mainly for
			// headless/tailed sessions — in the TUI the status line carries the stage).
			echo(
				ctx,
				"rsi-watch: following the in-flight run (poll 2s) — /rsi-stop interrupts it; this ends when the run closes",
			);
			let lastRunId: string | undefined;
			let seen = 0;
			const deadline = Date.now() + 2 * 60 * 60 * 1000; // hard cap: 2h
			while (Date.now() < deadline) {
				const run = getActiveRun();
				if (!run) {
					echo(ctx, lastRunId !== undefined ? `rsi-watch: run ${lastRunId} closed` : "rsi-watch: no run in flight");
					return;
				}
				if (run.runId !== lastRunId) {
					lastRunId = run.runId;
					seen = 0;
					echo(ctx, renderWatch(ctx.cwd, lines).text);
					seen = run.notes.length;
				} else {
					for (const note of run.notes.slice(seen)) echo(ctx, `  [${run.stage}] ${note}`);
					seen = run.notes.length;
					ctx.ui.setStatus("rsi", `watch ${run.runId}: ${run.stage}`);
					if (run.stopped) {
						await sleepMs(2000); // give the loop a beat to unwind and write the ledger
						echo(ctx, renderWatch(ctx.cwd, lines).text);
						return;
					}
				}
				await sleepMs(2000);
			}
			echo(ctx, "rsi-watch: follow deadline reached (2h) — run /rsi-watch --follow again to resume");
		},
	});

	pi.registerCommand("rsi-stop", {
		description:
			"Interrupt the in-flight rsi run: the current child-pi call is terminated and the run closes as aborted (nothing adopted)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const result = requestStop(ctx.cwd);
			say(ctx, `rsi: ${result.message}`, result.ok ? "warning" : "info");
			if (result.ok) ctx.ui.setStatus("rsi", "rsi: stopping…");
		},
	});

	// Surface a pending adoption at startup (cheap, file-only, no model call).
	pi.on("session_start", (_event, ctx) => {
		try {
			const pending = pendingInfo(ctx.cwd);
			if (pending) ctx.ui.setStatus("rsi", `rsi pending adoption: /rsi-adopt ${pending.label} --run ${pending.runId}`);
		} catch {
			// never block startup on rsi diagnostics
		}
	});
}

function sleepMs(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function inferDomain(task: string, cwd: string): string {
	const pathToken = task.match(/(?:^|\s)((?:[\w.-]+\/)+[\w.-]+)/)?.[1];
	if (pathToken) return pathToken.split("/")[0];
	const repo = cwd.split("/").filter(Boolean).pop() ?? "default";
	return repo;
}

function allRunIds(cwd: string): string[] {
	return listRunIds(cwd);
}

function setK(ctx: ExtensionCommandContext, raw: string): number {
	const wanted = Math.max(1, Math.floor(Number(raw) || 1));
	const clamped = clampK(wanted);
	if (wanted !== clamped) say(ctx, `rsi: --k ${wanted} capped to ${clamped} (concurrency/run-cost guard)`, "warning");
	return clamped;
}

function labelsOf(cwd: string, _runId: string | undefined): string[] {
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

function pendingInfo(cwd: string): { label: string; runId: string } | undefined {
	for (const runId of allRunIds(cwd)) {
		const ledger = loadLedger(join(cwd, ".pi", "harness", "runs", runId));
		if (ledger && ledger.outcome === "pending" && ledger.chosen) return { label: ledger.chosen, runId: ledger.runId };
	}
	return undefined;
}
