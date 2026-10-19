/**
 * Project continuity: an RSI run starts from the project that is already on
 * disk. That project's *subject* (what it is, what it is called, which artifact
 * is the main one) is inherited state, not scratch space — a run may improve it,
 * but it may not silently replace it with an unrelated project.
 *
 * `--replace` is the explicit opt-out. Without it the solver is told to continue
 * the existing project, and a deliverable whose subject no longer matches the
 * baseline fails the continuity guard before anything is adopted.
 *
 * The check is deliberately small and project-agnostic: it reads the standard
 * files that *name* a project (a manifest name, a README heading, and — when the
 * project is a web entry page — the page title/heading). It does not try to
 * understand the whole tree, and a project with no such label has no enforceable
 * identity and is never blocked.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface IdentityLabel {
	/** Repo-relative file the label was read from. */
	source: string;
	/** `metadata-name`, `readme-heading`, `entrypoint-title`, `entrypoint-heading`. */
	kind: string;
	/** The human label exactly as written. */
	text: string;
	/** Normalized, non-generic subject tokens of `text`. */
	subjects: string[];
}

export interface ProjectIdentity {
	labels: IdentityLabel[];
}

/**
 * Words that describe the *medium* rather than the subject. They are dropped
 * before comparing labels, so a presentation-only change (a new framework or
 * "Interactive 3D …" prefix) still matches the same project, while an
 * unrelated subject does not. Keep this list about packaging and presentation;
 * a word that could name a real subject must stay.
 */
const GENERIC = new Set([
	"a",
	"an",
	"and",
	"app",
	"application",
	"canvas",
	"css",
	"demo",
	"example",
	"for",
	"html",
	"in",
	"index",
	"interactive",
	"javascript",
	"js",
	"main",
	"my",
	"new",
	"of",
	"on",
	"or",
	"page",
	"project",
	"site",
	"the",
	"three",
	"threejs",
	"to",
	"ts",
	"untitled",
	"web",
	"website",
	"with",
	"2d",
	"3d",
]);

/** Max bytes read from one label file. Labels live in the head of a file. */
const MAX_READ = 256 * 1024;

/**
 * Standard metadata files, in the order they are read. Any ecosystem is fine;
 * a missing file simply contributes no label.
 */
const LABEL_FILES = [
	// Manifests: the project's own name.
	"package.json",
	"deno.json",
	"deno.jsonc",
	"composer.json",
	"pyproject.toml",
	"setup.cfg",
	"Cargo.toml",
	"go.mod",
	"mix.exs",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"settings.gradle",
	"settings.gradle.kts",
	// Human-facing description: the first heading usually names the project.
	"README.md",
	"README",
	"README.rst",
	"README.txt",
	// Web entry pages, when the project has one.
	"index.html",
	"public/index.html",
	"src/index.html",
	"app/index.html",
] as const;

/** Lowercase alphanumeric tokens; drops punctuation, numbers and medium words. */
export function subjectTokens(text: string): string[] {
	return [
		...new Set(
			text
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.filter((token) => token.length >= 2 && !/^\d+$/.test(token) && !GENERIC.has(token)),
		),
	];
}

function readHead(path: string): string | undefined {
	try {
		if (statSync(path).size > MAX_READ * 8) return undefined;
		return readFileSync(path, "utf8").slice(0, MAX_READ);
	} catch {
		return undefined;
	}
}

function firstMatch(text: string, re: RegExp): string | undefined {
	const match = re.exec(text);
	const value = match?.[1]?.trim();
	return value ? value : undefined;
}

/** `vendor/name` → `name`: compare the subject, not the registry namespace. */
function leafName(name: string | undefined): string | undefined {
	return name?.split("/").pop()?.trim() || undefined;
}

function labelsForFile(root: string, source: string): IdentityLabel[] {
	const text = readHead(join(root, source));
	if (text === undefined) return [];
	const out: IdentityLabel[] = [];
	const push = (kind: string, value: string | undefined): void => {
		if (!value) return;
		const subjects = subjectTokens(value);
		if (subjects.length > 0) out.push({ source, kind, text: value, subjects });
	};

	if (source.endsWith(".html")) {
		// A web entry page can name the project even without a manifest.
		push("entrypoint-title", firstMatch(text, /<title[^>]*>([\s\S]*?)<\/title>/i));
		push("entrypoint-heading", firstMatch(text, /<h1[^>]*>([\s\S]*?)<\/h1>/i)?.replace(/<[^>]+>/g, " "));
		return out;
	}
	if (source === "package.json" || source === "deno.json" || source === "deno.jsonc") {
		try {
			const pkg = JSON.parse(text) as { name?: unknown };
			if (typeof pkg.name === "string") push("metadata-name", leafName(pkg.name));
		} catch {
			// malformed manifest: no label, no false authority
		}
		return out;
	}
	if (source === "composer.json") {
		try {
			const pkg = JSON.parse(text) as { name?: unknown };
			if (typeof pkg.name === "string") push("metadata-name", leafName(pkg.name));
		} catch {
			// malformed manifest: no label, no false authority
		}
		return out;
	}
	if (source.startsWith("README")) {
		if (source.endsWith(".rst")) {
			// reStructuredText: the title is followed by an underline.
			const rst = firstMatch(text, /^(.+)\n[=\-~^"']{3,}\s*$/m);
			push("readme-heading", rst);
		} else {
			push("readme-heading", firstMatch(text, /^#{1,2}\s+(.+)$/m));
		}
		return out;
	}
	if (source === "go.mod") {
		push("metadata-name", leafName(firstMatch(text, /^module\s+(\S+)/m)));
		return out;
	}
	if (source === "pom.xml") {
		push("metadata-name", firstMatch(text, /<artifactId>([^<]+)<\/artifactId>/i));
		return out;
	}
	if (source.startsWith("build.gradle") || source.startsWith("settings.gradle")) {
		push("metadata-name", firstMatch(text, /rootProject\.name\s*=\s*["']([^"']+)["']/));
		return out;
	}
	if (source === "mix.exs") {
		push("metadata-name", firstMatch(text, /app:\s*:([a-z0-9_]+)/i));
		return out;
	}
	if (source === "setup.cfg") {
		push("metadata-name", firstMatch(text, /^name\s*=\s*(\S+)/m));
		return out;
	}
	// pyproject.toml / Cargo.toml
	push("metadata-name", firstMatch(text, /^name\s*=\s*["']([^"']+)["']/m));
	return out;
}

/** Read the project's identity labels from the tree at `root`. */
export function captureIdentity(root: string): ProjectIdentity {
	const labels: IdentityLabel[] = [];
	for (const source of LABEL_FILES) labels.push(...labelsForFile(root, source));
	return { labels };
}

function labelsOf(identity: ProjectIdentity, source: string): IdentityLabel[] {
	return identity.labels.filter((label) => label.source === source);
}

/**
 * Detect a subject replacement between the run baseline and a deliverable.
 *
 * Only sources present in *both* trees are compared, and only when both sides
 * carry real subject tokens. A file that named the project and disappeared is
 * also drift: removing the main artifact is replacing it.
 *
 * Returns `undefined` when continuity holds (or cannot be judged).
 */
export function subjectDrift(before: ProjectIdentity, after: ProjectIdentity): string | undefined {
	const sources = [...new Set(before.labels.map((label) => label.source))];
	for (const source of sources) {
		const oldLabels = labelsOf(before, source);
		const newLabels = labelsOf(after, source);
		if (oldLabels.length === 0) continue;
		if (newLabels.length === 0) {
			return `${source} no longer names the project (was "${oldLabels[0]?.text}")`;
		}
		const oldSubjects = new Set(oldLabels.flatMap((label) => label.subjects));
		const newSubjects = new Set(newLabels.flatMap((label) => label.subjects));
		const shared = [...oldSubjects].filter((subject) => newSubjects.has(subject));
		if (shared.length === 0) {
			const was = oldLabels.map((label) => label.text).join(" / ");
			const now = newLabels.map((label) => label.text).join(" / ");
			return `${source} changed subject from "${was}" to "${now}"`;
		}
	}
	return undefined;
}

/** One-line baseline description for the solver prompt and the ledger. */
export function describeIdentity(identity: ProjectIdentity): string {
	const labels = identity.labels.slice(0, 3).map((label) => `${label.source}: ${label.text}`);
	return labels.length > 0 ? labels.join("; ") : "(no explicit project label found)";
}

/**
 * The solver-facing continuity contract. `replace` is the explicit opt-out for
 * tasks whose whole point is a new subject.
 */
export function continuityPrompt(identity: ProjectIdentity, replace: boolean): string {
	if (replace) {
		return [
			"## Continuity contract",
			"Subject replacement is explicitly allowed for this run (`--replace`).",
			"Still leave every unrelated file and the project's checks intact.",
		].join("\n");
	}
	return [
		"## Continuity contract",
		"The project already exists. Its working tree is the baseline — not a blank slate.",
		"Continue and improve this project; do not replace its subject, name or main artifact.",
		`Baseline identity: ${describeIdentity(identity)}`,
		"Do not rename the project or substitute an unrelated subject.",
		"If the task asks for a different subject, stop and report the conflict instead of implementing it.",
		"Your result is compared with the baseline identity; a replacement fails the run.",
	].join("\n");
}

/** Generic nouns for "the thing this repository is". */
const PROJECT_NOUN =
	"project|app|application|program|tool|service|repo|repository|codebase|page|site|website|demo|game|library|package";

/**
 * Cheap task-level pre-flight: does the wording itself ask for a replacement?
 *
 * This is a *heuristic*, used only when the project has an explicit identity
 * and `--replace` was not passed. It catches the common failure where a task
 * is phrased as a greenfield instruction even though the user meant "improve
 * this project". False negatives are caught by the post-probe identity check;
 * false positives are resolved by the explicit `--replace` flag.
 */
export function requestsReplacement(task: string, identity?: ProjectIdentity): string | undefined {
	const text = task.toLowerCase().replace(/\s+/g, " ").trim();
	const target = `(the|this) (${PROJECT_NOUN})`;
	// If the project names an artifact (its entry page, manifest or README), a
	// task that says "turn <that file> into …" is a replacement too. This keeps
	// the check project-agnostic instead of hardcoding any file name.
	const artifacts = [...new Set((identity?.labels ?? []).map((label) => label.source.toLowerCase()))].map((source) =>
		source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
	);
	const artifact = artifacts.length > 0 ? `|${artifacts.join("|")}` : "";
	const patterns: ReadonlyArray<readonly [RegExp, string]> = [
		[new RegExp(`\\bturn\\b.{0,50}\\b(${target}${artifact})\\b.{0,50}\\binto\\b`), "turn the project into …"],
		[
			new RegExp(`\\brewrite\\b.{0,40}\\b(${target}${artifact})\\b.{0,40}\\b(into|as|from scratch)\\b`),
			"rewrite the project",
		],
		[
			new RegExp(
				`\\b(start|create|build|make)\\b.{0,40}\\b(new|another|fresh|different)\\b.{0,40}\\b(${PROJECT_NOUN})\\b`,
			),
			"create a new project",
		],
		[/\bnew project\b/, "new project"],
		[/\bstart over\b/, "start over"],
		[new RegExp(`\\breplace\\b.{0,40}\\b${target}\\b`), "replace the project"],
		[
			new RegExp(`\\b(scrap|discard)\\b.{0,40}\\b(existing|current|old) (${PROJECT_NOUN})\\b`),
			"scrap the existing project",
		],
	];
	for (const [pattern, reason] of patterns) if (pattern.test(text)) return reason;
	return undefined;
}
