/**
 * Per-repo settings for the verify loop and GitLab steps.
 *
 * Looked up in this order, first found wins:
 *   1. ~/.omp/llm-graphs/repos/<repo>.json   (yours, outside the checkout)
 *   2. <repo top>/.llm-graphs.json           (shared with the team, if you commit one)
 *
 * Example:
 * {
 *   "verify": [
 *     { "name": "build", "cmd": "make -j16", "timeout_min": 90 },
 *     { "name": "unit tests", "cmd": "ctest --output-on-failure", "timeout_min": 30 }
 *   ],
 *   "max_attempts": 3,
 *   "mr": { "target_branch": "develop", "reviewers": ["alice"], "labels": ["agent"], "draft": true },
 *   "pipeline": { "poll_sec": 60, "max_wait_min": 120 },
 *   "lead": true
 * }
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { slug } from "../report/store";

export interface Check {
	name: string;
	cmd: string;
	timeout_min?: number;
}

export interface MrConfig {
	target_branch: string;
	reviewers?: string[];
	labels?: string[];
	draft?: boolean;
	remove_source_branch?: boolean;
}

export interface RepoConfig {
	verify: Check[];
	max_attempts: number;
	mr?: MrConfig;
	pipeline: { poll_sec: number; max_wait_min: number };
	lead?: boolean; // lead mode on by default in this repo
	source?: string; // file it was read from
}

export function configDir(): string {
	const fromEnv = process.env.OMP_GRAPHS_CONFIG_DIR?.trim();
	if (fromEnv) return fromEnv.startsWith("~/") ? path.join(os.homedir(), fromEnv.slice(2)) : fromEnv;
	return path.join(os.homedir(), ".omp", "llm-graphs", "repos");
}

export function configPaths(repo: string, repoTop: string): string[] {
	return [path.join(configDir(), `${slug(repo, 60)}.json`), path.join(repoTop, ".llm-graphs.json")];
}

/** Returns the config, or an error string naming the file that failed to parse. */
export function loadConfig(repo: string, repoTop: string): { config?: RepoConfig; error?: string } {
	for (const p of configPaths(repo, repoTop)) {
		if (!fs.existsSync(p)) continue;
		let raw: Partial<RepoConfig>;
		try {
			raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<RepoConfig>;
		} catch (e) {
			return { error: `Could not read ${p}: ${(e as Error).message}` };
		}
		const verify = (raw.verify ?? []).filter(c => c && typeof c.cmd === "string" && c.cmd.trim());
		return {
			config: {
				verify: verify.map((c, i) => ({ name: c.name || `check ${i + 1}`, cmd: c.cmd, timeout_min: c.timeout_min })),
				max_attempts: raw.max_attempts ?? 3,
				mr: raw.mr?.target_branch ? raw.mr : undefined,
				pipeline: { poll_sec: raw.pipeline?.poll_sec ?? 60, max_wait_min: raw.pipeline?.max_wait_min ?? 120 },
				lead: raw.lead === true ? true : undefined,
				source: p,
			},
		};
	}
	return {};
}

export const CONFIG_TEMPLATE = `{
  "verify": [
    { "name": "build", "cmd": "make -j16", "timeout_min": 90 },
    { "name": "unit tests", "cmd": "ctest --output-on-failure", "timeout_min": 30 }
  ],
  "max_attempts": 3,
  "mr": { "target_branch": "develop", "reviewers": [], "labels": [], "draft": true },
  "pipeline": { "poll_sec": 60, "max_wait_min": 120 },
  "lead": false
}
`;
