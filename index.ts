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

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describeConfig, resolveConfig, type RsiConfig, type RsiSettings } from "./src/config";
import { adoptCandidate, runLoop, runReferenceProbes, statusOfRun, type LoopIO } from "./src/loop";
import { latestRunDir } from "./src/loop";
import { listDomains, listEntries, loadLessons, readIndex, regenerateIndex, revertSurface } from "./src/library";
import { loadLedger } from "./src/ledger";
import { readSurface } from "./src/surface";
import { truncateMiddle } from "./src/util";

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
		log(message: string): void {
			ctx.ui.setStatus("rsi", truncateMiddle(message.replace(/\s+/g, " "), 110));
			if (/adopted|fell back|identity|error|declined|pending|budget stop/i.test(message)) {
				say(ctx, message, "info");
			} else {
				echo(ctx, `[rsi] ${message}`);
			}
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
				say(ctx, "usage: /rsi [--domain <name>] [--k <n>] [--mode parallel|sequential] [--force] [--yes] <task>", "warning");
				return;
			}
			const kFlag = str(parsed.flags, "k");
			if (kFlag) cfg.k = Math.max(1, Math.floor(Number(kFlag) || 1));
			const mode = str(parsed.flags, "mode");
			if (mode === "sequential" || mode === "parallel") cfg.mode = mode;
			const domain = str(parsed.flags, "domain") ?? inferDomain(task, ctx.cwd);
			const force = parsed.flags.get("force") === true;
			const yes = parsed.flags.get("yes") === true;
			if (yes) cfg.confirmAdopt = false;

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
			if (kFlag) cfg.k = Math.max(1, Math.floor(Number(kFlag) || 1));
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
			ctx.ui.setStatus("rsi", pending ? `pending adoption: ${pending.label}` : (result.text.split("\n")[2] ?? "rsi"));
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
			const [domainArg, slugArg] = args.trim().split(/\s+/).filter((s) => s.length > 0);
			const live = readSurface(ctx.cwd, cfg);
			const result = revertSurface(ctx.cwd, cfg, live, { domain: domainArg, slug: slugArg });
			say(ctx, result.ok ? `rsi: ${result.message} (${result.restored})` : `rsi-revert: ${result.message}`, result.ok ? "info" : "warning");
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
			const items = ["--- INDEX.md ---", index.trim(), "--- entries ---", ...entries.map((e) => `${e.slug}  ·  ${e.cue}`)];
			if (!ctx.hasUI) {
				console.log(items.join("\n")); // headless: dump the index instead of prompting
				return;
			}
			const picked = await ctx.ui.select(`rsi library: ${domain}`, [...entries.map((e) => e.slug), "(view INDEX only)"]);
			if (!picked || picked === "(view INDEX only)") {
				await ctx.ui.editor(`${domain}/INDEX.md`, items.join("\n"));
				return;
			}
			const lessons = loadLessons(ctx.cwd, cfg, domain, picked, 1);
			await ctx.ui.editor(`${domain}/${picked}/EXPERIENCE.md`, lessons.lessons.join("\n\n") || items.join("\n"));
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

function inferDomain(task: string, cwd: string): string {
	const pathToken = task.match(/(?:^|\s)((?:[\w.-]+\/)+[\w.-]+)/)?.[1];
	if (pathToken) return pathToken.split("/")[0];
	const repo = cwd.split("/").filter(Boolean).pop() ?? "default";
	return repo;
}

function allRunIds(cwd: string): string[] {
	const runsDir = join(cwd, ".pi", "harness", "runs");
	try {
		return readdirSync(runsDir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
			.sort()
			.reverse();
	} catch {
		return [];
	}
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
