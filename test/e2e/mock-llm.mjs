// Scripted OpenAI-compatible chat server for the end-to-end test.
// Each request gets the next scripted reply, streamed as SSE.
import * as fs from "node:fs";
import * as http from "node:http";

const defaultScript = [
	{ tool: "write", args: { path: "gain.txt", content: "gain = 1.25\n" } },
	{ text: "Changed the gain." }, // stops without reporting -> plugin should nudge
	{
		tool: "report_step",
		args: {
			title: "Raised the pitch gain",
			done: "Changed the pitch gain in gain.txt from 1.0 to 1.25 to match the reference run. No other files were touched.",
			tests: [{ command: "make test", result: "pass", note: "mock" }],
			needs_you: ["Confirm 1.25 is inside the approved envelope"],
		},
	},
	{
		tool: "report_summary",
		args: {
			overview:
				"Raised the pitch gain to 1.25 in gain.txt. The mock test suite passed. Nothing else changed and no merge request was opened in this test run.",
			questions: [{ ask: "Let me know if you would like me to open a merge request." }],
		},
	},
	{
		tool: "report_summary",
		args: {
			overview:
				"Raised the pitch gain to 1.25 in gain.txt. The mock test suite passed. Nothing else changed and no merge request was opened in this test run.",
			questions: [
				{ ask: "Open a draft merge request to develop now?", options: ["Yes, open it", "No, I will review locally first"], recommend: "Yes, open it", why: "The change is one line and the tests passed." },
			],
		},
	},
	{ text: "All done." },
];

const script = process.env.SCRIPT ? JSON.parse(fs.readFileSync(process.env.SCRIPT, "utf8")) : defaultScript;

let n = 0;
const log = [];

function chunk(res, delta, finish = null) {
	const body = { id: "x", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta, finish_reason: finish }] };
	res.write(`data: ${JSON.stringify(body)}\n\n`);
}

const server = http.createServer((req, res) => {
	let raw = "";
	req.on("data", d => (raw += d));
	req.on("end", () => {
		if (!req.url.includes("chat/completions")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: "mock", object: "model" }] }));
			return;
		}
		const body = JSON.parse(raw || "{}");
		const step = script[Math.min(n, script.length - 1)];
		log.push({
			n,
			lastRole: body.messages?.at(-1)?.role,
			lastText: JSON.stringify(body.messages?.at(-1)?.content ?? "").slice(0, 600),
			...(n === 0 ? { tools: (body.tools ?? []).map(t => t.function?.name) } : {}),
		});
		n++;
		res.writeHead(200, { "content-type": "text/event-stream" });
		if (step.tool) {
			chunk(res, { role: "assistant", tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: step.tool, arguments: "" } }] });
			chunk(res, { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(step.args) } }] });
			chunk(res, {}, "tool_calls");
		} else {
			chunk(res, { role: "assistant", content: step.text });
			chunk(res, {}, "stop");
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

server.listen(Number(process.env.PORT ?? 18080), "127.0.0.1", () => console.log("mock ready"));
process.on("SIGTERM", () => {
	console.error(JSON.stringify(log, null, 1));
	process.exit(0);
});
