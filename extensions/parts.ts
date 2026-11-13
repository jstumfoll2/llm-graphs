/**
 * Which parts of the plugin are on. Inside a Firstmate worker, the parts that
 * Firstmate already owns are off by default: the lead (the first mate does
 * that), verify and the MR tools (the project's delivery path does that), and
 * lessons (Firstmate's /stow keeps memory).
 *
 * OMP_GRAPHS_DISABLE lists parts to turn off, comma separated; set it (even to
 * an empty string) to override the default.
 */
import { fmTask } from "./firstmate/fm";

export type Part = "lead" | "verify" | "lessons" | "cleanup";

export const FIRSTMATE_DEFAULT_OFF: Part[] = ["lead", "verify", "lessons"];

export function disabledParts(env: NodeJS.ProcessEnv = process.env): Set<string> {
	const raw = env.OMP_GRAPHS_DISABLE;
	if (raw !== undefined) return new Set(raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
	return new Set(fmTask(env) ? FIRSTMATE_DEFAULT_OFF : []);
}

export function partOn(part: Part, env: NodeJS.ProcessEnv = process.env): boolean {
	return !disabledParts(env).has(part);
}
