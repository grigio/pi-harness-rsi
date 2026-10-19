/**
 * The `/rsi start` command handler must not block until the run ends: pi only
 * returns to its input loop once the handler resolves, so a synchronous
 * `/rsi start` makes a same-session `/rsi stop` undeliverable until the run has
 * already finished. This pins the fix: the handler returns while the run is
 * still in flight, which is what lets `/rsi stop` reach `requestStop`.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import rsiExtension from "../index";
import { getActiveRun } from "../src/watch";

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
	const dir = mkdtempSync(join(tmpdir(), "rsi-cmd-stub-"));
	const bin = join(dir, "pi-stub");
	writeFileSync(bin, STUB);
	chmodSync(bin, 0o755);
	return bin;
}

function fakePi(settings: unknown): (args: string, ctx: unknown) => Promise<void> {
	let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const pi = {
		getSettings: () => settings,
		registerCommand: (_name: string, opts: { handler: typeof handler }) => {
			handler = opts.handler;
		},
		on: () => {},
	};
	// biome-ignore lint/suspicious/noExplicitAny: minimal ExtensionAPI stand-in
	rsiExtension(pi as any);
	if (!handler) throw new Error("command not registered");
	return handler;
}

function fakeCtx(cwd: string): Record<string, unknown> {
	return {
		cwd,
		hasUI: true,
		ui: {
			notify: () => {},
			setStatus: () => {},
			editor: async () => {},
			confirm: async () => false,
			select: async () => undefined,
		},
	};
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
}

describe("the command handler stays responsive while a run is in flight", () => {
	test("start returns before the loop ends, and a follow-up stop reaches requestStop", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "rsi-cmd-"));
		writeFileSync(join(cwd, "README.md"), "# demo\n");
		const bin = writeStub();
		const previousBin = process.env.PI_RSI_PI_BIN;
		const previousFake = process.env.PI_RSI_FAKE;
		process.env.PI_RSI_PI_BIN = bin;
		delete process.env.PI_RSI_FAKE;
		try {
			const handler = fakePi({
				rsi: { profile: "small", k: 1, maxParallel: 2, stageTimeoutMs: 3_000, requireClean: false },
			});
			const ctx = fakeCtx(cwd);

			const startedAt = Date.now();
			await handler("start --force keep the checks green", ctx);
			// The handler resolved even though the loop has only just started.
			expect(Date.now() - startedAt).toBeLessThan(3_000);
			expect(getActiveRun()).toBeDefined();

			await handler("stop", ctx);
			// requestStop saw the live registry, not the "no run in flight" fallback.
			expect(getActiveRun()?.stopped).toBe(true);

			await waitFor(() => getActiveRun() === undefined, 20_000);
			expect(getActiveRun()).toBeUndefined();
		} finally {
			if (previousBin === undefined) delete process.env.PI_RSI_PI_BIN;
			else process.env.PI_RSI_PI_BIN = previousBin;
			if (previousFake === undefined) delete process.env.PI_RSI_FAKE;
			else process.env.PI_RSI_FAKE = previousFake;
		}
	}, 40_000);
});

describe("headless /rsi commands complete before the handler resolves", () => {
	test("a probe with hasUI=false runs to completion (not detached into an abandoned loop)", async () => {
		// Regression: `pi --print "/rsi probe …"` exited as soon as the handler
		// resolved. The loop was detached for TUI responsiveness, so it never got
		// to run a single rollout — and its `running` ledger was left behind as a
		// phantom. Headless has no input loop to keep responsive: await the work.
		const cwd = mkdtempSync(join(tmpdir(), "rsi-headless-"));
		writeFileSync(join(cwd, "README.md"), "# demo\n");
		const previousFake = process.env.PI_RSI_FAKE;
		process.env.PI_RSI_FAKE = "1";
		try {
			const handler = fakePi({ rsi: { profile: "small", k: 1, requireClean: false } });
			const ctx = fakeCtx(cwd);
			ctx.hasUI = false;

			await handler("probe --domain demo make the checks green", ctx);

			// The run finished inside the handler: no registry entry left, and the
			// ledger on disk carries a terminal outcome rather than "running".
			expect(getActiveRun()).toBeUndefined();
			const runs = readdirSync(join(cwd, ".pi", "harness", "runs"));
			expect(runs.length).toBe(1);
			const ledger = JSON.parse(
				readFileSync(join(cwd, ".pi", "harness", "runs", runs[0] as string, "ledger.json"), "utf8"),
			);
			expect(ledger.outcome).toBe("probed");
		} finally {
			if (previousFake === undefined) delete process.env.PI_RSI_FAKE;
			else process.env.PI_RSI_FAKE = previousFake;
		}
	}, 40_000);
});
