import { describe, expect, test } from "bun:test";
import { MIN_USD, resolveConfig } from "../src/config";

const env = {} as NodeJS.ProcessEnv;

describe("resolveConfig — money and counts that must not silently floor to zero", () => {
	test("a fractional maxUsd is honoured, never floored to 0", () => {
		// `POSITIVE_INT` turned 0.5 into 0 and the run aborted before its first stage.
		expect(resolveConfig({ maxUsd: 0.5 }, env).maxUsd).toBe(0.5);
		expect(resolveConfig({ maxUsd: 1.75 }, env).maxUsd).toBe(1.75);
		expect(resolveConfig({ maxUsd: 2 }, env).maxUsd).toBe(2);
	});

	test("a nonsensical maxUsd falls back to the default rather than to zero", () => {
		expect(resolveConfig({ maxUsd: 0 }, env).maxUsd).toBe(2);
		expect(resolveConfig({ maxUsd: -1 }, env).maxUsd).toBe(2);
		expect(resolveConfig({ maxUsd: Number.NaN }, env).maxUsd).toBe(2);
		expect(resolveConfig({ maxUsd: 0.001 }, env).maxUsd).toBe(2); // below MIN_USD
		expect(MIN_USD).toBeGreaterThan(0);
	});

	test("a fractional keepRuns never becomes 0 (which would prune every run)", () => {
		expect(resolveConfig({ keepRuns: 0.5 }, env).keepRuns).toBe(20);
		expect(resolveConfig({ keepRuns: 5 }, env).keepRuns).toBe(5);
	});

	test("budget overrides below the floor are ignored, not turned into 0", () => {
		const cfg = resolveConfig({ budgets: { proposeMission: 0 } }, env);
		expect(cfg.budgets.proposeMission).toBeGreaterThan(0);
		const cfg2 = resolveConfig({ budgets: { proposeMission: 123 } }, env);
		expect(cfg2.budgets.proposeMission).toBe(123);
	});

	test("the env escape hatch honours any positive value", () => {
		expect(resolveConfig({ maxUsd: 100 }, { PI_RSI_MAX_USD: "0.02" } as NodeJS.ProcessEnv).maxUsd).toBe(0.02);
		expect(resolveConfig({ maxUsd: 100 }, { PI_RSI_MAX_USD: "0" } as NodeJS.ProcessEnv).maxUsd).toBe(100);
	});
});
