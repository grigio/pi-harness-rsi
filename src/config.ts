/**
 * Settings schema, budget profiles and environment resolution for rsi.
 *
 * Budgets are profiles, not constants (README “Context budgets”). Every number here is
 * a hard char cap that `context.assemble()` enforces; `rsi.budgets.*` overrides
 * single keys after profile selection.
 */

export type Profile = "small" | "large";
export type RunMode = "parallel" | "sequential";

/** All values are character budgets unless stated otherwise. */
export interface Budgets {
	/** Always-on AGENTS.md cap enforced by surface.validate(). */
	agentsMd: number;
	/** Skill `description:` frontmatter cap (pi's hard max is 1024). */
	skillDescription: number;
	/** Skill body size that only produces a warning. */
	skillBodyWarn: number;
	/** Trajectory digest per rollout (hard cap in trajectory.digest()). */
	digest: number;
	/** Deliverable excerpt per candidate in the select stage. */
	deliverableExcerpt: number;
	/** Propose mission, fully assembled. */
	proposeMission: number;
	/** Compose mission, fully assembled. */
	composeMission: number;
	/** Reflect mission, fully assembled. */
	reflectMission: number;
	/**
	 * Select mission, fully assembled. Not capped by any per-artifact table (the
	 * table only caps per-deliverable excerpts) but `assemble()` needs a declared
	 * budget for the stage too — declared here and shown in `/rsi status`.
	 */
	selectMission: number;
	/** `<notes>` / `<why>` decision notes per stage. */
	notes: number;
}

export const PROFILES: Record<Profile, Budgets> = {
	small: {
		agentsMd: 6_000,
		skillDescription: 300,
		skillBodyWarn: 4_000,
		digest: 6_000,
		deliverableExcerpt: 8_000,
		proposeMission: 16_000,
		composeMission: 24_000,
		reflectMission: 8_000,
		selectMission: 16_000,
		notes: 600,
	},
	large: {
		agentsMd: 12_000,
		skillDescription: 1_024,
		skillBodyWarn: 12_000,
		digest: 16_000,
		deliverableExcerpt: 24_000,
		proposeMission: 48_000,
		composeMission: 64_000,
		reflectMission: 24_000,
		selectMission: 48_000,
		notes: 2_000,
	},
};

export const DEFAULT_FORBIDDEN_GLOBS = [
	"tests/**",
	"test/**",
	"**/*.test.ts",
	"**/*.spec.ts",
	".github/**",
	"package.json",
	"package-lock.json",
	"bun.lock",
	"bun.lockb",
	"pnpm-lock.yaml",
	"yarn.lock",
];

export interface RsiSettings {
	profile?: Profile;
	k?: number;
	mode?: RunMode;
	editorModel?: string | null;
	solverModel?: string | null;
	thinking?: string | null;
	verifier?: string | null;
	confirmAdopt?: boolean;
	maxUsd?: number;
	/**
	 * Wall-clock cap for a whole run, in minutes. The USD cap is blind to free
	 * models (`usd: 0.0000`), so time is the budget that always binds.
	 */
	maxRunMinutes?: number;
	maxParallel?: number;
	libraryDir?: string;
	worktreeRoot?: string;
	budgets?: Partial<Record<keyof Budgets, number>>;
	forbiddenGlobs?: string[];
	/** Frozen tool allowlist for every solver arm (matched conditions). */
	tools?: string;
	/** Editor child runs are answer-only: no write/edit tools. */
	editorTools?: string;
	/** Refuse to run with uncommitted changes in the working tree (default true). */
	requireClean?: boolean;
	stageTimeoutMs?: number;
	/** Old run directories kept under .pi/harness/runs (retention window). */
	keepRuns?: number;
}

export interface RsiConfig {
	profile: Profile;
	k: number;
	mode: RunMode;
	editorModel: string | null;
	solverModel: string | null;
	thinking: string | null;
	verifier: string | null;
	confirmAdopt: boolean;
	maxUsd: number;
	/** Wall-clock cap for a whole run (ms). See `maxRunMinutes`. */
	maxRunMs: number;
	/** Where `maxRunMs` came from (setting vs `PI_RSI_MAX_MINUTES`). */
	maxRunSource: "setting" | "env";
	maxParallel: number;
	libraryDir: string;
	worktreeRoot: string;
	forbiddenGlobs: string[];
	tools: string[];
	editorTools: string[];
	budgets: Budgets;
	requireClean: boolean;
	stageTimeoutMs: number;
	/** Run directories kept under `.pi/harness/runs` (see src/retention.ts). */
	keepRuns: number;
	/** PI_RSI_FAKE=1 — deterministic editor/probe, zero model calls. */
	fake: boolean;
	/** PI_RSI_FAKE_SCENARIO — fake editor behaviour under test. */
	fakeScenario: "valid" | "invalid-first" | "always-invalid";
	/** PI_RSI_MAX_USD overrides rsi.maxUsd. */
	maxUsdSource: "setting" | "env";
}

const POSITIVE_INT = (n: unknown, fallback: number): number =>
	typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;

/**
 * Money and other fractional quantities. `POSITIVE_INT` floors, which silently
 * turned `maxUsd: 0.5` into 0 — and `spent >= 0` aborts the run before its first
 * stage. Values below the floor are rejected back to the default instead.
 */
const POSITIVE_FLOAT = (n: unknown, fallback: number, min: number): number =>
	typeof n === "number" && Number.isFinite(n) && n >= min ? n : fallback;

/** Smallest budget worth honouring: a run that cannot spend a cent is a misconfiguration. */
export const MIN_USD = 0.01;
/** Default wall-clock cap: 30 minutes, independent of USD (free models still take time).
 *
 * The cap must be larger than a single stage timeout (10 min by default): with
 * `k=1` a real run is three rollouts plus three editor sessions and routinely
 * takes 7–20 minutes on a free model, so a smaller cap aborts every run before
 * the propose stage can finish.
 */
export const DEFAULT_MAX_RUN_MS = 30 * 60_000;
/** Below a minute a real run cannot even finish one probe; reject the misconfiguration. */
export const MIN_MAX_RUN_MS = 60_000;
/** A profile override of 0 chars would make every stage fail; 1 char is honoured. */
const MIN_BUDGET_CHARS = 1;

/** Upper bounds that keep a typo (`--k 100`) from spawning 400 rollouts. */
export const MAX_K = 8;
export const MAX_PARALLEL = 8;

export function clampK(n: number): number {
	return Math.min(MAX_K, Math.max(1, POSITIVE_INT(n, 1)));
}

export function clampParallel(n: number): number {
	return Math.min(MAX_PARALLEL, Math.max(1, POSITIVE_INT(n, 1)));
}

export function resolveConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): RsiConfig {
	const s = (raw ?? {}) as RsiSettings;
	const profile: Profile = s.profile === "large" ? "large" : "small";
	const budgets: Budgets = { ...PROFILES[profile] };
	if (s.budgets && typeof s.budgets === "object") {
		for (const [key, value] of Object.entries(s.budgets as Record<string, unknown>)) {
			if (key in budgets && typeof value === "number" && Number.isFinite(value) && value >= MIN_BUDGET_CHARS) {
				budgets[key as keyof Budgets] = Math.floor(value);
			}
		}
	}

	const envMaxUsd = env.PI_RSI_MAX_USD !== undefined ? Number(env.PI_RSI_MAX_USD) : undefined;
	// The env override is an explicit operator escape hatch: any positive value is
	// honoured (tests pin a near-zero budget to prove the fail-closed stop).
	const envMaxUsdOk = envMaxUsd !== undefined && Number.isFinite(envMaxUsd) && envMaxUsd > 0;
	const envMaxMinutes = env.PI_RSI_MAX_MINUTES !== undefined ? Number(env.PI_RSI_MAX_MINUTES) : undefined;
	const envMaxMinutesOk = envMaxMinutes !== undefined && Number.isFinite(envMaxMinutes) && envMaxMinutes > 0;
	const settingMaxMs =
		typeof s.maxRunMinutes === "number" && Number.isFinite(s.maxRunMinutes) && s.maxRunMinutes > 0
			? Math.round(s.maxRunMinutes * 60_000)
			: undefined;
	// Like `PI_RSI_MAX_USD`, the env override is an operator escape hatch: any
	// positive value is honoured (tests pin a near-zero budget to prove the
	// fail-closed stop), while the setting is floored at `MIN_MAX_RUN_MS`.
	const maxRunMs = envMaxMinutesOk
		? Math.round((envMaxMinutes as number) * 60_000)
		: Math.max(MIN_MAX_RUN_MS, settingMaxMs ?? DEFAULT_MAX_RUN_MS);
	const fakeRaw = (env.PI_RSI_FAKE ?? "").trim();
	const fake = fakeRaw === "1" || fakeRaw.toLowerCase() === "true";

	return {
		profile,
		k: clampK(POSITIVE_INT(s.k, 1)),
		mode: s.mode === "sequential" ? "sequential" : "parallel",
		editorModel: typeof s.editorModel === "string" && s.editorModel.length > 0 ? s.editorModel : null,
		solverModel: typeof s.solverModel === "string" && s.solverModel.length > 0 ? s.solverModel : null,
		thinking: typeof s.thinking === "string" && s.thinking.length > 0 ? s.thinking : null,
		verifier: typeof s.verifier === "string" && s.verifier.trim().length > 0 ? s.verifier.trim() : null,
		confirmAdopt: s.confirmAdopt !== false,
		maxUsd: envMaxUsdOk ? (envMaxUsd as number) : POSITIVE_FLOAT(s.maxUsd, 2, MIN_USD),
		maxRunMs,
		maxRunSource: envMaxMinutesOk ? "env" : "setting",
		maxParallel: clampParallel(POSITIVE_INT(s.maxParallel, 2)),
		libraryDir: typeof s.libraryDir === "string" && s.libraryDir ? s.libraryDir : ".pi/harness/library",
		worktreeRoot: typeof s.worktreeRoot === "string" && s.worktreeRoot ? s.worktreeRoot : ".pi/harness/worktrees",
		forbiddenGlobs:
			Array.isArray(s.forbiddenGlobs) && s.forbiddenGlobs.length > 0 ? s.forbiddenGlobs : DEFAULT_FORBIDDEN_GLOBS,
		tools: splitTools(s.tools, "read,bash,edit,write,grep,find,ls"),
		editorTools: splitTools(s.editorTools, "read,grep,find,ls"),
		budgets,
		requireClean: s.requireClean !== false,
		stageTimeoutMs: POSITIVE_INT(s.stageTimeoutMs, 600_000),
		keepRuns: POSITIVE_FLOAT(s.keepRuns, 20, 1),
		fake,
		fakeScenario:
			env.PI_RSI_FAKE_SCENARIO === "invalid-first"
				? "invalid-first"
				: env.PI_RSI_FAKE_SCENARIO === "always-invalid"
					? "always-invalid"
					: "valid",
		maxUsdSource: envMaxUsdOk ? "env" : "setting",
	};
}

function splitTools(value: string | undefined, fallback: string): string[] {
	const src = typeof value === "string" && value.trim().length > 0 ? value : fallback;
	return src
		.split(",")
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
}

/** Human-readable one-liner for status output. */
export function describeConfig(cfg: RsiConfig): string {
	const spend = cfg.maxUsdSource === "env" ? `${cfg.maxUsd} (env)` : `${cfg.maxUsd}`;
	const wall = cfg.maxRunSource === "env" ? `${formatMinutes(cfg.maxRunMs)} (env)` : formatMinutes(cfg.maxRunMs);
	return (
		`profile=${cfg.profile} k=${cfg.k} mode=${cfg.mode} fake=${cfg.fake ? "1" : "0"} ` +
		`maxUsd=${spend} maxRun=${wall} confirmAdopt=${cfg.confirmAdopt ? "1" : "0"}`
	);
}

/** `300000` → `5m`, `90000` → `1.5m` — compact enough for the one-line header. */
export function formatMinutes(ms: number): string {
	const minutes = ms / 60_000;
	return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}m`;
}
