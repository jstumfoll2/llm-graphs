#!/usr/bin/env node
// Adds the llm-graphs worker settings to Firstmate's omp worker overlay
// (.omp/fm-worker-overlay.yml) by merging them into the blocks already there.
//
// A plain patch appends a new top-level `advisor:` block. If your overlay
// already has one (say with `enabled: false`), that makes a duplicate key, and
// YAML loaders either reject the file or keep only the last block, which can
// drop your own advisor settings. This script edits the existing block instead,
// adds only missing keys, and changes a key only when its value differs. Safe
// to run twice.
//
// Usage: node merge-worker-overlay.mjs [--check] [path]
//   path     your Firstmate checkout, or the overlay file (default: current folder)
//   --check  say what would change, write nothing
// Exit: 0 done (or nothing to do), 2 the file can't be merged safely (it says why).
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const OVERLAY = ".omp/fm-worker-overlay.yml";

/** [section, key, value, comment for a newly added section]. */
export const SETTINGS = [
	[
		"advisor",
		"continueSeverity",
		"blocker",
		[
			"Only matters when the captain turned the advisor on in config.yml (it is",
			"off by default). A worker's own advisor otherwise wakes it after its final",
			'answer for every "concern" note, which shows up as two or three rounds of',
			"re-summarizing. Validation already reviews the change, so a worker only",
			"continues for a blocker, and gets at most one note per review.",
		],
	],
	["advisor", "maxNotesPerUpdate", "1", []],
	[
		"recap",
		"enabled",
		"false",
		["The idle recap asks the model for a summary of an unattended pane; nobody", "reads it, and on a shared local model it takes a slot from real work."],
	],
];

const TOP = /^([A-Za-z_][\w.-]*)\s*:(.*)$/;

/** Top-level keys with their line ranges; a block ends at the next top-level key. */
function blocks(lines) {
	const out = [];
	lines.forEach((l, i) => {
		const m = TOP.exec(l);
		if (!m) return;
		if (out.length) out.at(-1).end = i;
		out.push({ key: m[1], rest: m[2].replace(/\s+#.*$/, "").trim(), start: i, end: lines.length });
	});
	return out;
}

/** Pure: returns the merged text plus what changed, or an error. */
export function mergeOverlay(text) {
	const lines = text.replace(/\n$/, "").split("\n");
	const seen = new Map();
	for (const b of blocks(lines)) {
		if (seen.has(b.key)) return { error: `top-level "${b.key}:" appears twice (lines ${seen.get(b.key) + 1} and ${b.start + 1}); merge them by hand first` };
		seen.set(b.key, b.start);
	}
	const changes = [];
	for (const [section, key, value, comment] of SETTINGS) {
		const b = blocks(lines).find((x) => x.key === section);
		const entry = `  ${key}: ${value}`;
		if (!b) {
			lines.push(`${section}:`, ...comment.map((c) => `  # ${c}`), entry);
			changes.push(`added ${section}.${key}: ${value} (new "${section}:" block)`);
			continue;
		}
		if (b.rest !== "") return { error: `"${section}:" has an inline value (${b.rest}); write it as an indented block first` };
		const keyRe = new RegExp(`^(\\s+)${key}\\s*:\\s*([^#]*?)\\s*(#.*)?$`);
		let found = -1;
		for (let i = b.start + 1; i < b.end; i++) if (keyRe.test(lines[i])) found = i;
		if (found >= 0) {
			const [, indent, old, trail] = keyRe.exec(lines[found]);
			if (old.replace(/^["']|["']$/g, "") === value) continue;
			lines[found] = `${indent}${key}: ${value}${trail ? ` ${trail}` : ""}`;
			changes.push(`changed ${section}.${key}: ${old} -> ${value}`);
			continue;
		}
		// insert after the block's last indented line, using the block's own indent
		let last = b.start;
		let indent = "  ";
		for (let i = b.start + 1; i < b.end; i++) {
			const m = /^(\s+)\S/.exec(lines[i]);
			if (m) {
				last = i;
				if (!lines[i].trimStart().startsWith("#")) indent = m[1];
			}
		}
		const add = [...comment.map((c) => `${indent}# ${c}`), `${indent}${key}: ${value}`];
		lines.splice(last + 1, 0, ...add);
		changes.push(`added ${section}.${key}: ${value} (into the existing "${section}:" block)`);
	}
	return { text: `${lines.join("\n")}\n`, changes };
}

function main(argv) {
	const check = argv.includes("--check");
	const arg = argv.find((a) => !a.startsWith("--")) ?? ".";
	const file = fs.existsSync(arg) && fs.statSync(arg).isDirectory() ? path.join(arg, OVERLAY) : arg;
	if (!fs.existsSync(file)) {
		console.error(`No such file: ${file}`);
		return 2;
	}
	const r = mergeOverlay(fs.readFileSync(file, "utf8"));
	if (r.error) {
		console.error(`${file}: ${r.error}.`);
		return 2;
	}
	if (!r.changes.length) console.log(`${file}: already has every setting, nothing to do.`);
	for (const c of r.changes) console.log(`${file}: ${check ? "would be " : ""}${c}`);
	if (!check && r.changes.length) fs.writeFileSync(file, r.text);
	return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
