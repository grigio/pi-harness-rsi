import { describe, expect, test } from "bun:test";
import { flagBool, flagString, HELP, helpText, isVerb, parseCommand, usageOf, VERBS } from "../src/args";

describe("/rsi argument parsing (src/args.ts)", () => {
	test("no verb: the whole line is a start task", () => {
		const cmd = parseCommand("fix the flaky session test");
		expect(cmd.verb).toBeNull();
		expect(cmd.text).toBe("fix the flaky session test");
		expect(cmd.errors).toEqual([]);
	});

	test("empty line parses as the state view", () => {
		const cmd = parseCommand("   ");
		expect(cmd.verb).toBeNull();
		expect(cmd.text).toBe("");
		expect(cmd.errors).toEqual([]);
	});

	test("every verb is recognised, case-sensitively", () => {
		for (const verb of VERBS) {
			expect(parseCommand(`${verb} x`).verb).toBe(verb);
		}
		// A capitalised word is task text, not a verb.
		expect(parseCommand("Start the server").verb).toBeNull();
		expect(isVerb("Start")).toBe(false);
	});

	test("flags before the task, task text verbatim after it", () => {
		const cmd = parseCommand("start --k 2 --domain acme run the verifier --verbose");
		expect(cmd.verb).toBe("start");
		expect(flagString(cmd, "k")).toBe("2");
		expect(flagString(cmd, "domain")).toBe("acme");
		expect(cmd.text).toBe("run the verifier --verbose");
		expect(cmd.errors).toEqual([]);
	});

	test("boolean flags never swallow the next word (the old --yes bug)", () => {
		const cmd = parseCommand("start --yes fix the flaky test");
		expect(flagBool(cmd, "yes")).toBe(true);
		expect(cmd.text).toBe("fix the flaky test");
		expect(cmd.errors).toEqual([]);

		const adopt = parseCommand("adopt --yes final0");
		expect(flagBool(adopt, "yes")).toBe(true);
		expect(adopt.positional).toEqual(["final0"]);
	});

	test("--flag=value form", () => {
		const cmd = parseCommand("start --k=2 --domain=acme do the thing");
		expect(flagString(cmd, "k")).toBe("2");
		expect(flagString(cmd, "domain")).toBe("acme");
		expect(cmd.text).toBe("do the thing");
	});

	test("`--` ends flag parsing so a task may start with a flag", () => {
		const cmd = parseCommand("start --k 2 -- --verbose should not be a flag");
		expect(flagString(cmd, "k")).toBe("2");
		expect(cmd.text).toBe("--verbose should not be a flag");
		expect(cmd.errors).toEqual([]);
	});

	test("quoted task is accepted with or without quotes", () => {
		expect(parseCommand('start "fix the flaky test"').text).toBe("fix the flaky test");
		expect(parseCommand("start 'fix the flaky test'").text).toBe("fix the flaky test");
		expect(parseCommand("start fix the flaky test").text).toBe("fix the flaky test");
	});

	test("errors: unknown flag, missing value, value on a boolean", () => {
		expect(parseCommand("start --nope task").errors[0]).toContain("unknown flag --nope");
		expect(parseCommand("start --k").errors[0]).toContain("--k needs a value");
		expect(parseCommand("start --yes=1 task").errors[0]).toContain("does not take a value");
		// A flag valid for one verb is not silently accepted by another.
		expect(parseCommand("probe --yes task").errors[0]).toContain("unknown flag --yes");
	});

	test("discrete-arg verbs accept flags after a positional", () => {
		const cmd = parseCommand("adopt final0 --run 20261019-093543-add-a-health-endpoint --yes");
		expect(cmd.positional).toEqual(["final0"]);
		expect(flagString(cmd, "run")).toBe("20261019-093543-add-a-health-endpoint");
		expect(flagBool(cmd, "yes")).toBe(true);
		expect(cmd.errors).toEqual([]);
	});

	test("help text lists every verb and its usage", () => {
		const text = helpText();
		for (const verb of VERBS) {
			expect(text).toContain(`/rsi ${HELP[verb].usage}`);
		}
		expect(usageOf("revert")).toBe("usage: /rsi revert <domain>/<slug> [--force]");
	});
});
