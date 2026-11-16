#!/usr/bin/env node
// Adds the "Reply shape" rules to Firstmate's AGENTS.md.
//
// The edits target the section by its name, "Escalation and captain etiquette",
// not by its number, so forks that renumbered their sections (section 8 instead
// of 9, say) get the same result. Safe to run twice: edits already in place are
// skipped.
//
// Usage: node apply-reply-shape.mjs [--check] [path]
//   path     your Firstmate checkout, or its AGENTS.md (default: current folder)
//   --check  say what would change, write nothing
// Exit: 0 all edits in place, 1 an edit could not be placed (the rest are
// written unless --check), 2 bad input (file or section not found).
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const SECTION_NAME = "Escalation and captain etiquette";

const REPLY_SHAPE = (h) => `${h} Reply shape

Every captain-facing chat message follows this shape, on every harness.
It governs layout and length; the rest of this section governs content and wording.

1. **First line: the point.** One sentence with the outcome, or the ask when the captain owes a decision. Never open with background, what you checked, or how you got there.
2. **Then the facts that change what the captain would do,** at most about five short lines. Leave out steps tried, routine progress, and anything the captain would not act on. Put longer detail in a report file and link it.
3. **Questions last, never mid-message.** Every question goes in one block at the end, numbered, one decision each, answerable with a letter or yes/no:

   \`\`\`
   Q1. Merge the login fix now? https://.../pull/42
       (a) merge  (b) wait for the flaky test rerun
       Recommended: (a), checks are green and the rerun is unrelated.
   \`\`\`

   A sentence earlier in the message must not end in a question mark or ask for a choice; if it needs the captain, move it into the block.
   With no question block, the captain owes nothing; say so only if they might think otherwise.
4. **Plain sentences.** Under about 25 words each, one idea per sentence, no stacked clauses or parenthetical asides, no hedging chains. Prefer a short list over a long paragraph when there are three or more parallel items.

The final-message, translation and URL rules below still apply; they say what goes in, this shape says where.
`;

// Rewrites of existing lines in the section: [what it is, old text, new text].
const REWRITES = [
	[
		"escalation rule leads with the ask",
		"Lead directly with concrete evidence, then the consequence, options when applicable, and a recommendation.\nUse the same evidence-first form for objections or clarifying challenges rather than unsupported deference.",
		"Lead with the ask in one sentence, then the concrete evidence and consequence, then the numbered question block with options and a recommendation (Reply shape above).\nUse the same form for objections or clarifying challenges rather than unsupported deference: the objection first, then the evidence for it.",
	],
	[
		"batched updates go between first line and questions",
		"- Batch non-urgent updates into the next natural reply.",
		"- Batch non-urgent updates into the next natural reply, below its first line and above its question block.",
	],
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Finds the section by name, whatever its number. Returns line indexes [start, end). */
export function findSection(lines, name = SECTION_NAME) {
	const re = new RegExp(`^(#{1,6})\\s+(?:\\d+(?:\\.\\d+)*\\.?\\s+)?${escapeRe(name)}\\s*$`, "i");
	const hits = lines.flatMap((l, i) => (re.test(l) ? [i] : []));
	if (hits.length !== 1) return { error: hits.length ? `"${name}" is a heading ${hits.length} times` : `no heading named "${name}"` };
	const start = hits[0];
	const level = re.exec(lines[start])[1].length;
	let end = lines.length;
	let fence = false;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^\s*```/.test(lines[i])) fence = !fence;
		const m = !fence && /^(#{1,6})\s/.exec(lines[i]);
		if (m && m[1].length <= level) {
			end = i;
			break;
		}
	}
	return { start, end, level };
}

/** Pure: returns the new text plus what was done, skipped and left for you. */
export function applyReplyShape(text) {
	const lines = text.split("\n");
	const sec = findSection(lines);
	if (sec.error) return { error: sec.error };
	const before = lines.slice(0, sec.start + 1);
	let body = lines.slice(sec.start + 1, sec.end).join("\n");
	const after = lines.slice(sec.end);
	const done = [];
	const skipped = [];
	const failed = [];

	const sub = "#".repeat(Math.min(sec.level + 1, 6));
	if (new RegExp(`^#{1,6}\\s+Reply shape\\s*$`, "m").test(body)) skipped.push("Reply shape block");
	else {
		body = `\n${REPLY_SHAPE(sub)}${body.replace(/^\n+/, "\n")}`;
		done.push("Reply shape block");
	}
	for (const [what, from, to] of REWRITES) {
		if (body.includes(to)) skipped.push(what);
		else if (body.includes(from)) {
			body = body.replace(from, to);
			done.push(what);
		} else failed.push({ what, from, to });
	}
	return { text: [...before, body, ...after].join("\n"), heading: lines[sec.start], done, skipped, failed };
}

function main(argv) {
	const check = argv.includes("--check");
	const arg = argv.find((a) => !a.startsWith("--")) ?? ".";
	const file = fs.existsSync(arg) && fs.statSync(arg).isDirectory() ? path.join(arg, "AGENTS.md") : arg;
	if (!fs.existsSync(file)) {
		console.error(`No such file: ${file}`);
		return 2;
	}
	const r = applyReplyShape(fs.readFileSync(file, "utf8"));
	if (r.error) {
		console.error(`${file}: ${r.error}. Add the block by hand; see firstmate/README.md.`);
		return 2;
	}
	console.log(`${file}: section "${r.heading.replace(/^#+\s*/, "")}"`);
	for (const d of r.done) console.log(`  ${check ? "would apply" : "applied"}: ${d}`);
	for (const s of r.skipped) console.log(`  already there: ${s}`);
	for (const f of r.failed) console.log(`  NOT FOUND, edit by hand (${f.what}). Replace:\n    ${f.from.replace(/\n/g, "\n    ")}\n  with:\n    ${f.to.replace(/\n/g, "\n    ")}`);
	if (!check && r.done.length) fs.writeFileSync(file, r.text);
	return r.failed.length ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
