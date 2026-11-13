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
		// Writes outside the checkout or to OMP's internal URIs don't need a verify.
		for (const p of ["/data/scratch/notes.md", "../../scratch/x", "xd:/write"]) {
			expect(needsVerify([{ ...edit, path: p }], [])).toBe(false);
		}
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
	const cfgDir = path.join(tmp, "cfg");
	const top = path.join(tmp, "repo");
	fs.mkdirSync(cfgDir, { recursive: true });
	fs.mkdirSync(top, { recursive: true });
	const withEnv = (env: Record<string, string | undefined>, fn: () => void) => {
		const old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
		for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
		try {
			fn();
		} finally {
			for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
		}
	};

	test("a config the agent can write in the checkout is ignored by default", () => {
		withEnv({ OMP_GRAPHS_CONFIG_DIR: cfgDir, OMP_GRAPHS_TRUST_REPO_CONFIG: undefined }, () => {
			expect(loadConfig("repo", top)).toEqual({ ignored: undefined });
			const repoFile = path.join(top, ".llm-graphs.json");
			fs.writeFileSync(repoFile, JSON.stringify({ verify: [{ cmd: "touch /tmp/pwned" }], mr: { target_branch: "main" } }));
			const r = loadConfig("repo", top);
			expect(r.config).toBeUndefined();
			expect(r.ignored).toBe(repoFile);
		});
		withEnv({ OMP_GRAPHS_CONFIG_DIR: cfgDir, OMP_GRAPHS_TRUST_REPO_CONFIG: "1" }, () => {
			expect(loadConfig("repo", top).config?.verify[0]).toEqual({ name: "check 1", cmd: "touch /tmp/pwned", timeout_min: undefined });
		});
		fs.rmSync(path.join(top, ".llm-graphs.json"));
	});

	test("a user config dir inside the checkout is refused, symlinks included", () => {
		withEnv({ OMP_GRAPHS_CONFIG_DIR: path.join(top, ".omp-cfg") }, () => {
			expect(loadConfig("repo", top).error).toContain("inside the checkout");
		});
		const link = path.join(tmp, "cfg-link");
		fs.symlinkSync(top, link);
		withEnv({ OMP_GRAPHS_CONFIG_DIR: link }, () => {
			expect(loadConfig("repo", top).error).toContain("inside the checkout");
		});
	});

	test("user config is read; bad JSON is reported", () => {
		withEnv({ OMP_GRAPHS_CONFIG_DIR: cfgDir, OMP_GRAPHS_TRUST_REPO_CONFIG: "1" }, () => {
			fs.writeFileSync(path.join(top, ".llm-graphs.json"), JSON.stringify({ verify: [{ cmd: "make" }] }));
			fs.writeFileSync(path.join(cfgDir, "repo.json"), JSON.stringify({ verify: [{ name: "b", cmd: "ninja" }], mr: { target_branch: "develop" } }));
			const c = loadConfig("repo", top).config!;
			expect(c.verify[0]!.cmd).toBe("ninja"); // yours wins over the repo's
			expect(c.mr?.target_branch).toBe("develop");
			expect(c.max_attempts).toBe(3);
			fs.writeFileSync(path.join(cfgDir, "repo.json"), "{oops");
			expect(loadConfig("repo", top).error).toContain("Could not read");
		});
	});
});
