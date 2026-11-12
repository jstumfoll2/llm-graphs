import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../extensions/verify/config";
import {
	capLog,
	failuresForStep,
	mrDescription,
	needsVerify,
	parseMrUrl,
	parsePipeline,
	tailLines,
	type VerifyRun,
} from "../extensions/verify/state";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llmg-verify-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const run = (ts: string, ok: boolean, step?: number): VerifyRun => ({ ts, ok, step, results: [] });

describe("verify rules", () => {
	test("verify is needed only after edits since the last pass", () => {
		const edit = { ts: "2026-11-11T01:00:00Z", tool: "edit", path: "a.cpp", error: false };
		expect(needsVerify([], [])).toBe(false); // investigation only
		expect(needsVerify([edit], [])).toBe(true);
		expect(needsVerify([edit], [run("2026-11-11T02:00:00Z", true)])).toBe(false);
		expect(needsVerify([edit], [run("2026-11-11T02:00:00Z", false)])).toBe(true);
		expect(needsVerify([{ ...edit, ts: "2026-11-11T03:00:00Z" }], [run("2026-11-11T02:00:00Z", true)])).toBe(true);
		expect(needsVerify([{ ...edit, tool: "bash" }], [])).toBe(false);
	});

	test("failures are counted per step", () => {
		const runs = [run("a", false, 1), run("b", false, 1), run("c", true, 1), run("d", false, 2)];
		expect(failuresForStep(runs, 1)).toBe(2);
		expect(failuresForStep(runs, 2)).toBe(1);
		expect(failuresForStep(runs, 3)).toBe(0);
		expect(failuresForStep(runs, 1, "b")).toBe(1); // a reopen starts a fresh count
	});

	test("logs are capped to their tail", () => {
		const f = path.join(tmp, "big.log");
		fs.writeFileSync(f, `${"x".repeat(5000)}END`);
		capLog(f, 100);
		const t = fs.readFileSync(f, "utf8");
		expect(t.endsWith("END")).toBe(true);
		expect(t).toContain("bytes dropped");
		expect(tailLines("a\nb\nc\n\n", 2)).toBe("b\nc");
	});
});

describe("glab output", () => {
	test("finds the MR URL", () => {
		expect(parseMrUrl("Creating merge request...\nhttps://gitlab.example.com/grp/sub/sim/-/merge_requests/42\n")).toBe(
			"https://gitlab.example.com/grp/sub/sim/-/merge_requests/42",
		);
		expect(parseMrUrl("error: nope")).toBeUndefined();
	});

	test("reads pipeline JSON", () => {
		const p = parsePipeline(
			JSON.stringify({ status: "failed", web_url: "u", jobs: [{ id: 7, name: "unit", stage: "test", status: "failed", extra: 1 }] }),
		);
		expect(p).toEqual({ status: "failed", url: "u", jobs: [{ id: 7, name: "unit", stage: "test", status: "failed" }] });
		expect(parsePipeline("not json")).toBeUndefined();
	});

	test("MR description lists changes, checks and steps", () => {
		const d = mrDescription({
			overview: "Fixed the gain lookup.",
			changedFiles: ["src/gain.cpp"],
			lastVerify: {
				ts: "t",
				ok: true,
				results: [{ name: "unit", cmd: "ctest", ok: true, code: 0, timedOut: false, secs: 12, log: "l" }],
			},
			stepsDone: ["Write a test", "Fix the lookup"],
		});
		expect(d).toContain("`src/gain.cpp`");
		expect(d).toContain("`ctest`: passed (12s)");
		expect(d).toContain("2. Fix the lookup");
	});
});

describe("config", () => {
	test("user config wins over repo config; bad JSON is reported", () => {
		const cfgDir = path.join(tmp, "cfg");
		const top = path.join(tmp, "repo");
		fs.mkdirSync(cfgDir, { recursive: true });
		fs.mkdirSync(top, { recursive: true });
		process.env.OMP_GRAPHS_CONFIG_DIR = cfgDir;
		expect(loadConfig("repo", top)).toEqual({});
		fs.writeFileSync(path.join(top, ".llm-graphs.json"), JSON.stringify({ verify: [{ cmd: "make" }] }));
		expect(loadConfig("repo", top).config?.verify[0]).toEqual({ name: "check 1", cmd: "make", timeout_min: undefined });
		fs.writeFileSync(path.join(cfgDir, "repo.json"), JSON.stringify({ verify: [{ name: "b", cmd: "ninja" }], mr: { target_branch: "develop" } }));
		const c = loadConfig("repo", top).config!;
		expect(c.verify[0]!.cmd).toBe("ninja");
		expect(c.mr?.target_branch).toBe("develop");
		expect(c.max_attempts).toBe(3);
		fs.writeFileSync(path.join(cfgDir, "repo.json"), "{oops");
		expect(loadConfig("repo", top).error).toContain("Could not read");
		delete process.env.OMP_GRAPHS_CONFIG_DIR;
	});
});
