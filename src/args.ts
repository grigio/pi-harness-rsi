/**
 * The `/rsi` command surface: one command, verb first.
 *
 *   /rsi <verb> [--flag value ...] [--] <task or args>
 *
 * Two rules keep the surface predictable:
 *
 * 1. The first token is a verb *only if it is one of the lowercase verbs below*.
 *    Anything else is a task, so `/rsi fix the flaky test` still means
 *    `start` and `Start the server` is never mistaken for the `start` verb.
 * 2. `start`/`probe` take free task text: flags are parsed only *before* the
 *    first task word, so a task may contain `--verbose` or quotes without
 *    escaping, and `--` ends flag parsing explicitly. Verbs that take discrete
 *    arguments (`adopt`, `status`, `revert`) accept flags anywhere, so
 *    `/rsi adopt final0 --run <id> --yes` works as written.
 *
 * The parser is deliberately strict: an unknown flag or a value flag with no
 * value is an error the command prints, never a silent reinterpretation of the
 * task (the previous `--yes fix it` bug swallowed `fix` as the flag value).
 */

export const VERBS = ["start", "probe", "status", "watch", "stop", "adopt", "revert", "library", "help"] as const;

export type Verb = (typeof VERBS)[number];

export function isVerb(value: string): value is Verb {
	return (VERBS as readonly string[]).includes(value);
}

export interface FlagSpec {
	/** Flags that take `--name <value>` or `--name=<value>`. */
	value: readonly string[];
	/** Flags that stand alone (`--name`). */
	bool: readonly string[];
}

export const FLAGS: Record<Verb, FlagSpec> = {
	start: { value: ["k", "domain", "mode"], bool: ["yes", "force", "replace"] },
	probe: { value: ["k", "domain"], bool: ["replace"] },
	status: { value: [], bool: [] },
	watch: { value: ["lines"], bool: ["once", "follow"] },
	stop: { value: [], bool: [] },
	adopt: { value: ["run"], bool: ["yes", "force"] },
	revert: { value: [], bool: ["force"] },
	library: { value: [], bool: [] },
	help: { value: [], bool: [] },
};

export interface ParsedCommand {
	/** `null` when no verb was given: the whole line is the task (default `start`). */
	verb: Verb | null;
	/** Task text / positional args after the verb and flags, verbatim. */
	text: string;
	positional: string[];
	flags: Map<string, string | boolean>;
	errors: string[];
}

interface Token {
	value: string;
	start: number;
	end: number;
}

/** Whitespace split that honours single/double quotes and backslash escapes. */
function tokenize(raw: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < raw.length) {
		while (i < raw.length && /\s/.test(raw.charAt(i))) i++;
		if (i >= raw.length) break;
		const start = i;
		let value = "";
		let quote: string | null = null;
		while (i < raw.length) {
			const ch = raw.charAt(i);
			if (quote) {
				if (ch === "\\" && i + 1 < raw.length) {
					value += raw.charAt(i + 1);
					i += 2;
					continue;
				}
				if (ch === quote) {
					quote = null;
					i++;
					continue;
				}
				value += ch;
				i++;
				continue;
			}
			if (ch === '"' || ch === "'") {
				quote = ch;
				i++;
				continue;
			}
			if (/\s/.test(ch)) break;
			if (ch === "\\" && i + 1 < raw.length) {
				value += raw.charAt(i + 1);
				i += 2;
				continue;
			}
			value += ch;
			i++;
		}
		tokens.push({ value, start, end: i });
	}
	return tokens;
}

/** Verbs whose argument is free task text: there, the first non-flag token starts
 * the task and nothing after it is a flag (so a task may contain `--verbose`).
 * Every other verb takes discrete args, so flags may appear anywhere. */
const FREE_TEXT_VERBS: readonly Verb[] = ["start", "probe"];

export function parseCommand(raw: string): ParsedCommand {
	const tokens = tokenize(raw);
	const errors: string[] = [];
	const flags = new Map<string, string | boolean>();
	const positional: string[] = [];
	if (tokens.length === 0) return { verb: null, text: "", positional, flags, errors };

	const first = tokens[0];
	if (!first) return { verb: null, text: "", positional, flags, errors };
	const verb: Verb | null = isVerb(first.value) ? first.value : null;
	let cursor = verb ? 1 : 0;
	let textStart = verb ? first.end : 0;
	// With no verb the whole line is a task, so it behaves like `start`.
	const freeText = verb === null || FREE_TEXT_VERBS.includes(verb);
	const spec = FLAGS[verb ?? "start"];
	while (cursor < tokens.length) {
		const tok = tokens[cursor];
		if (!tok) break;
		// Free-text verbs: the first non-flag token starts the task.
		if (!tok.value.startsWith("--")) {
			if (freeText) break;
			positional.push(tok.value);
			cursor++;
			continue;
		}
		if (tok.value === "--") {
			cursor++;
			textStart = tok.end;
			break;
		}
		const body = tok.value.slice(2);
		const eq = body.indexOf("=");
		const name = eq >= 0 ? body.slice(0, eq) : body;
		const inline = eq >= 0 ? body.slice(eq + 1) : undefined;

		if (spec.bool.includes(name)) {
			if (inline !== undefined) errors.push(`--${name} does not take a value (got --${name}=${inline})`);
			else flags.set(name, true);
			if (freeText) textStart = tok.end;
			cursor++;
			continue;
		}
		if (spec.value.includes(name)) {
			if (inline !== undefined) {
				if (inline.length === 0) errors.push(`--${name} needs a value`);
				else flags.set(name, inline);
				if (freeText) textStart = tok.end;
				cursor++;
				continue;
			}
			const next = tokens[cursor + 1];
			if (!next) {
				errors.push(`--${name} needs a value`);
				if (freeText) textStart = tok.end;
				cursor++;
				continue;
			}
			flags.set(name, next.value);
			if (freeText) textStart = next.end;
			cursor += 2;
			continue;
		}
		errors.push(`unknown flag --${name} for \`${verb ?? "start"}\` — see /rsi help; use \`--\` to stop parsing flags`);
		if (freeText) textStart = tok.end;
		cursor++;
	}
	for (let i = cursor; i < tokens.length; i++) {
		const value = tokens[i]?.value;
		if (value !== undefined) positional.push(value);
	}

	let text = raw.slice(textStart).trim();
	// Discrete-arg verbs have no free task text: `text` is the positional args.
	if (!freeText) text = positional.join(" ");
	// `/rsi start "fix the flaky test"` — strip one surrounding quote pair.
	if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text[text.length - 1] === text[0]) {
		text = text.slice(1, -1).trim();
	}
	return { verb, text, positional, flags, errors };
}

/** Typed accessors — flags are already validated by `parseCommand`. */
export function flagString(cmd: ParsedCommand, name: string): string | undefined {
	const value = cmd.flags.get(name);
	return typeof value === "string" ? value : undefined;
}

export function flagBool(cmd: ParsedCommand, name: string): boolean {
	return cmd.flags.get(name) === true;
}

// ---------------------------------------------------------------------------
// Help text (single source of truth for `/rsi help`, bare `/rsi` and errors)
// ---------------------------------------------------------------------------

export interface VerbHelp {
	usage: string;
	summary: string;
}

export const HELP: Record<Verb, VerbHelp> = {
	start: {
		usage: "start [--k n] [--domain d] [--mode parallel|sequential] [--yes] [--force] [--replace] <task>",
		summary: "run the full loop (probe → propose → probe → compose → probe → adopt → reflect)",
	},
	probe: {
		usage: "probe [--k n] [--domain d] [--replace] <task>",
		summary: "reference executions + digests only — no editor, no edits, no adoption",
	},
	status: {
		usage: "status [runId]",
		summary: "the in-flight run if there is one, otherwise the latest ledger and the next step",
	},
	watch: {
		usage: "watch [--once] [--lines n]",
		summary: "live view of the in-flight run (polls until it closes); --once prints a snapshot",
	},
	stop: {
		usage: "stop",
		summary: "interrupt the in-flight run (closes as aborted, nothing adopted)",
	},
	adopt: {
		usage: "adopt [label] [--run runId] [--yes] [--force]",
		summary: "human gate: apply a candidate surface from a run, snapshot the library, reflect",
	},
	revert: {
		usage: "revert <domain>/<slug> [--force]",
		summary: "restore the previous adopted surface for one library entry",
	},
	library: {
		usage: "library [domain]",
		summary: "browse library domains, INDEX.md and EXPERIENCE.md",
	},
	help: {
		usage: "help",
		summary: "this table",
	},
};

/** The table printed by bare `/rsi` and `/rsi help`. */
export function helpText(): string {
	const width = Math.max(...VERBS.map((v) => HELP[v].usage.length));
	const rows = VERBS.map((v) => `  /rsi ${HELP[v].usage.padEnd(width)}  ${HELP[v].summary}`);
	return [
		"usage: /rsi <verb> [flags] [args]   —   the verb may be omitted, then the line is a `start` task",
		"",
		...rows,
		"",
		"flags come before the task (`start`/`probe`); `adopt`/`status`/`revert` accept them anywhere.",
	].join("\n");
}

/** Usage line for a single verb (error messages). */
export function usageOf(verb: Verb): string {
	return `usage: /rsi ${HELP[verb].usage}`;
}
