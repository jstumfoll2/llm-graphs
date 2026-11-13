/**
 * Per-repo settings for the verify loop and GitLab steps.
 *
 * Read from ~/.omp/llm-graphs/repos/<repo>.json (yours, outside the checkout).
 *
 * The config names shell commands that verify runs and turns on open_mr,
 * which pushes and creates an MR. Anything inside the checkout can be written
 * by the agent or a worker, so a file there must never be able to grant that:
 *   - <repo top>/.llm-graphs.json is ignored unless you set
 *     OMP_GRAPHS_TRUST_REPO_CONFIG=1 in the environment that starts omp.
 *   - A user config path that resolves inside the checkout (for example
 *     OMP_GRAPHS_CONFIG_DIR pointing into it) is refused.
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

export const REPO_CONFIG_FILE = ".llm-graphs.json";

export function trustRepoConfig(): boolean {
	return process.env.OMP_GRAPHS_TRUST_REPO_CONFIG?.trim() === "1";
}

/** Files that may be read, in order. The in-checkout file is listed only when you opted in. */
export function configPaths(repo: string, repoTop: string): string[] {
	const user = path.join(configDir(), `${slug(repo, 60)}.json`);
	return trustRepoConfig() ? [user, path.join(repoTop, REPO_CONFIG_FILE)] : [user];
}

function realish(p: string): string {
	// Resolve symlinks on the longest existing prefix, so a link into the checkout is caught too.
	let dir = path.resolve(p);
	const rest: string[] = [];
	while (!fs.existsSync(dir)) {
		const up = path.dirname(dir);
		if (up === dir) break;
		rest.unshift(path.basename(dir));
		dir = up;
	}
	try {
		dir = fs.realpathSync(dir);
	} catch {}
	return path.join(dir, ...rest);
}

export function insideTree(file: string, top: string): boolean {
	const rel = path.relative(realish(top), realish(file));
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export interface LoadResult {
	config?: RepoConfig;
	error?: string;
	ignored?: string; // an in-checkout config that was skipped, so a "not configured" message can say why
}

/** Returns the config, or an error string naming the file that failed to parse. */
export function loadConfig(repo: string, repoTop: string): LoadResult {
	const repoFile = path.join(repoTop, REPO_CONFIG_FILE);
	const ignored = !trustRepoConfig() && fs.existsSync(repoFile) ? repoFile : undefined;
	for (const p of configPaths(repo, repoTop)) {
		if (p !== repoFile && insideTree(p, repoTop)) {
			return { error: `Refusing ${p}: it is inside the checkout, where the agent can write it. Keep the config outside ${repoTop}.`, ignored };
		}
		if (!fs.existsSync(p)) continue;
		let raw: Partial<RepoConfig>;
		try {
			raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<RepoConfig>;
		} catch (e) {
			return { error: `Could not read ${p}: ${(e as Error).message}`, ignored };
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
			ignored,
		};
	}
	return { ignored };
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
