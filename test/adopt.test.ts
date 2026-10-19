import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config";
import { newLedger, saveLedger } from "../src/ledger";
import { heldRunLock } from "../src/lock";
import { adoptCandidate } from "../src/loop";
import { readSurface } from "../src/surface";
import { getActiveRun } from "../src/watch";

const cfg = resolveConfig({ profile: "small" }, { PI_RSI_FAKE: "1" } as NodeJS.ProcessEnv);

/** A minimal, readable run directory containing the given surface snapshots. */
function makeRun(cwd: string, runId: string, snapshots: Record<string, unknown>): string {
	const runDir = join(cwd, ".pi", "harness", "runs", runId);
	mkdirSync(join(runDir, "surfaces"), { recursive: true });
	const ledger = newLedger(runId, "tighten the checks", "demo", cfg);
	ledger.chosen = "final0";
	saveLedger(runDir, ledger);
	for (const [label, surface] of Object.entries(snapshots)) {
		writeFileSync(join(runDir, "surfaces", `${label}.json`), JSON.stringify(surface));
	}
	return runDir;
}

function project(): string {
	const cwd = mkdtempSync(join(tmpdir(), "rsi-adopt-"));
	writeFileSync(join(cwd, "AGENTS.md"), "# Project\n\n- keep the checks green\n");
	return cwd;
}

const io = { log: () => {} };

describe("/rsi adopt — the human gate must be a safe, transactional command", () => {
	test("a traversal label is rejected and the live tree is untouched", async () => {
		const cwd = project();
		makeRun(cwd, "r1", {});
		// Plant a plausible payload one directory above the project.
		const evil = join(cwd, "..", `${Date.now()}-evil.json`);
		writeFileSync(evil, JSON.stringify({ "AGENTS.md": "# pwned\n" }));

		const result = await adoptCandidate({
			cwd,
			cfg,
			io,
			runId: "r1",
			label: "../../../evil",
			confirmed: true,
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("invalid label");
		expect(readSurface(cwd, cfg)["AGENTS.md"]).toBe("# Project\n\n- keep the checks green\n");
	});

	test("a traversal run id is rejected", async () => {
		const cwd = project();
		const result = await adoptCandidate({ cwd, cfg, io, runId: "../../etc", confirmed: true });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("invalid run id");
	});

	test("a snapshot identical to the live surface is a no-op, not a successful adoption", async () => {
		const cwd = project();
		makeRun(cwd, "r1", { final0: readSurface(cwd, cfg) });

		const result = await adoptCandidate({ cwd, cfg, io, runId: "r1", confirmed: true });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("nothing to adopt");
		// no library snapshot, no lock, no live run
		expect(existsSync(join(cwd, ".pi", "harness", "library"))).toBe(false);
		expect(heldRunLock(cwd)).toBeUndefined();
		expect(getActiveRun()).toBeUndefined();
	});

	test("a real change is adopted and snapshotted into the library", async () => {
		const cwd = project();
		const next = { ...readSurface(cwd, cfg), "AGENTS.md": "# Project\n\n- keep the checks green\n- run typecheck\n" };
		makeRun(cwd, "r1", { final0: next });

		const result = await adoptCandidate({ cwd, cfg, io, runId: "r1", confirmed: true, force: true });
		expect(result.ok).toBe(true);
		expect(readSurface(cwd, cfg)["AGENTS.md"]).toContain("run typecheck");
		expect(existsSync(join(cwd, ".pi", "harness", "library", "demo"))).toBe(true);
		// lock + registry released on the success path too
		expect(heldRunLock(cwd)).toBeUndefined();
		expect(getActiveRun()).toBeUndefined();
	});

	test("a failing apply releases the lock and restores the live surface (no wedge)", async () => {
		const cwd = project();
		const before = readSurface(cwd, cfg)["AGENTS.md"];
		const next = { ...readSurface(cwd, cfg), "AGENTS.md": "# Project\n\n- keep the checks green\n- run typecheck\n" };
		makeRun(cwd, "r1", { final0: next });
		// Inject a failure *after* the live surface is written: the library root is a
		// regular file, so `adoptSurface` cannot create its entry directory. The
		// transaction must roll the live surface back and release the lock.
		mkdirSync(join(cwd, ".pi", "harness"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "harness", "library"), "not a directory");

		const result = await adoptCandidate({ cwd, cfg, io, runId: "r1", confirmed: true, force: true });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("adoption failed");
		expect(readSurface(cwd, cfg)["AGENTS.md"]).toBe(before);
		expect(heldRunLock(cwd)).toBeUndefined();
		expect(getActiveRun()).toBeUndefined();
	});

	test("an unreadable snapshot is refused", async () => {
		const cwd = project();
		makeRun(cwd, "r1", {});
		const result = await adoptCandidate({ cwd, cfg, io, runId: "r1", label: "missing", confirmed: true });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("no snapshot for label");
	});

	test("validation failure refuses without touching the tree", async () => {
		const cwd = project();
		makeRun(cwd, "r1", { final0: { "AGENTS.md": "# x\n", ".pi/skills/bad/SKILL.md": "no frontmatter here\n" } });
		const result = await adoptCandidate({ cwd, cfg, io, runId: "r1", confirmed: true });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("fails validation");
	});
});
