/**
 * Regression for the `/rsi stop` candidate-probe bug: reference and final
 * probes were wired to `ctx.signal`, but candidate probes were wired to the
 * *external* `LoopOptions.signal` (usually undefined), so a stop during the
 * candidate stage only took effect at the next stage boundary — up to
 * `stageTimeoutMs` later.
 *
 * The child `pi` here is a stub script: solver reference runs finish instantly,
 * editor runs return an empty delta, and candidate runs sleep. With the fix a
 * `/rsi stop` (abort of `ctx.signal`) kills the sleeping candidate child
 * promptly; without it, the run hangs until the stage timeout.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config";
import { runLoop } from "../src/loop";
import { getActiveRun, requestStop } from "../src/watch";

const STUB = `#!/bin/sh
dir=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--session-dir" ]; then dir="$a"; fi
  prev="$a"
done
mkdir -p "$dir"
case "$dir" in
  *editor-*)
    printf '%s\\n' '{"type":"message","message":{"role":"assistant","content":"<notes>noop</notes>\\n\`\`\`json\\n{\\"files\\":[]}\\n\`\`\`"}}' > "$dir/sess.jsonl"
    exit 0 ;;
  *ref*)
    printf '%s\\n' '{"type":"message","message":{"role":"assistant","content":"done"}}' > "$dir/sess.jsonl"
    exit 0 ;;
  *)
    sleep 60 ;;
esac
`;

function writeStub(): string {
	const dir = mkdtempSync(join(tmpdir(), "rsi-stub-"));
	const bin = join(dir, "pi-stub");
	writeFileSync(bin, STUB);
	chmodSync(bin, 0o755);
	return bin;
}

describe("/rsi stop during candidate probes (regression)", () => {
	test("aborts the sleeping candidate child promptly instead of waiting for the stage timeout", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "rsi-stop-"));
		writeFileSync(join(cwd, "README.md"), "# demo\n");
		const bin = writeStub();
		const previous = process.env.PI_RSI_PI_BIN;
		process.env.PI_RSI_PI_BIN = bin;
		try {
			// fake=false: every child is the stub. A short stage timeout keeps a
			// regression from hanging the suite for 10 minutes.
			const cfg = {
				...resolveConfig({ profile: "small", k: 1, maxParallel: 2, stageTimeoutMs: 3_000 }, {} as NodeJS.ProcessEnv),
				fake: false,
			};
			const started = Date.now();
			const pending = runLoop({
				cfg,
				cwd,
				task: "keep the checks green",
				domain: "demo",
				force: true,
				runId: "stop-candidate",
				io: { log: () => {}, confirmAdoption: async () => true },
			});

			// Wait until the candidate probes are the active stage, then stop.
			const deadline = Date.now() + 15_000;
			let staged = false;
			while (Date.now() < deadline) {
				const stage = getActiveRun()?.stage ?? "";
				if (/^probe (inv|dom)/.test(stage)) {
					staged = true;
					break;
				}
				await new Promise((r) => setTimeout(r, 10));
			}
			expect(staged).toBe(true);
			expect(requestStop().ok).toBe(true);

			const report = await pending;
			expect(report.outcome).toBe("aborted");
			expect(report.adopted).toBe(false);
			// Prompt abort (well under the 3s stage timeout): proves the child was killed.
			expect(Date.now() - started).toBeLessThan(15_000);
		} finally {
			if (previous === undefined) delete process.env.PI_RSI_PI_BIN;
			else process.env.PI_RSI_PI_BIN = previous;
		}
	}, 40_000);
});

describe("wall-clock budget (the USD cap is blind to free models)", () => {
	test("a run past maxRun aborts as aborted_timeout and kills the in-flight child", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "rsi-deadline-"));
		writeFileSync(join(cwd, "README.md"), "# demo\n");
		const bin = writeStub();
		const previous = process.env.PI_RSI_PI_BIN;
		process.env.PI_RSI_PI_BIN = bin;
		try {
			// The stub's candidate runs sleep 60s; a 1.2s wall-clock budget aborts
			// the run long before that, and long before the 3s stage timeout.
			const cfg = {
				...resolveConfig({ profile: "small", k: 1, maxParallel: 2, stageTimeoutMs: 3_000 }, {
					PI_RSI_MAX_MINUTES: "0.02",
				} as NodeJS.ProcessEnv),
				fake: false,
			};
			expect(cfg.maxRunSource).toBe("env");
			const started = Date.now();
			const report = await runLoop({
				cfg,
				cwd,
				task: "keep the checks green",
				domain: "demo",
				force: true,
				runId: "deadline",
				io: { log: () => {}, confirmAdoption: async () => true },
			});
			expect(report.outcome).toBe("aborted_timeout");
			expect(report.adopted).toBe(false);
			expect(Date.now() - started).toBeLessThan(15_000);
			expect(report.status).toContain("time:");
		} finally {
			if (previous === undefined) delete process.env.PI_RSI_PI_BIN;
			else process.env.PI_RSI_PI_BIN = previous;
		}
	}, 40_000);
});
