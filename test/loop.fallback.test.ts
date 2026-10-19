/**
 * Regression: a stage that fell back to the base surface recorded
 * `wallMs: attempts * 1` — a fabricated duration. The ledger's wall time sits
 * next to the USD budget, so it must be measured, not invented.
 *
 * The child here is a stub: solver runs finish instantly and every editor run
 * sleeps, then proposes an off-surface edit so validation fails twice and the
 * stage falls back. The recorded fallback session must therefore carry the real
 * (slow) duration, not the attempt count.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config";
import { loadLedger } from "../src/ledger";
import { runLoop } from "../src/loop";

const EDITOR_SLEEP_MS = 300;
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
    sleep 0.3
    printf '%s\\n' '{"type":"message","message":{"role":"assistant","content":"<notes>off-surface</notes>\\n\`\`\`json\\n{\\"files\\":[{\\"path\\":\\"../escape.md\\",\\"op\\":\\"write\\",\\"content\\":\\"x\\"}]}\\n\`\`\`"}}' > "$dir/sess.jsonl"
    exit 0 ;;
  *)
    printf '%s\\n' '{"type":"message","message":{"role":"assistant","content":"done"}}' > "$dir/sess.jsonl"
    exit 0 ;;
esac
`;

describe("fallback ledger entries carry measured time, not the attempt count", () => {
	test("a slow editor fallback records its real wall time", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "rsi-fallback-"));
		writeFileSync(join(cwd, "README.md"), "# demo\n");
		const bin = join(cwd, "..", `${Date.now()}-pi-stub`);
		writeFileSync(bin, STUB);
		chmodSync(bin, 0o755);
		const previous = process.env.PI_RSI_PI_BIN;
		process.env.PI_RSI_PI_BIN = bin;
		try {
			const cfg = {
				...resolveConfig({ profile: "small", k: 1, maxParallel: 2, stageTimeoutMs: 10_000 }, {} as NodeJS.ProcessEnv),
				fake: false,
			};
			const report = await runLoop({
				cfg,
				cwd,
				task: "keep the checks green",
				domain: "demo",
				force: true,
				runId: "fallback-time",
				io: { log: () => {}, confirmAdoption: async () => false },
			});
			const ledger = loadLedger(report.runDir);
			const sessions = (ledger?.entries ?? []).filter((e) => e.kind === "session");
			expect(sessions.length).toBeGreaterThan(0);
			for (const entry of sessions) {
				// Two attempts of ~300ms each; the old code recorded exactly 1ms.
				expect(entry.wallMs ?? 0).toBeGreaterThanOrEqual(EDITOR_SLEEP_MS);
			}
			expect(report.outcome).not.toBe("adopted");
		} finally {
			if (previous === undefined) delete process.env.PI_RSI_PI_BIN;
			else process.env.PI_RSI_PI_BIN = previous;
		}
	}, 60_000);
});
