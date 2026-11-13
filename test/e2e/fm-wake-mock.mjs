// Mock model for fm-wake-widget.sh: arms the Firstmate watcher when asked,
// answers title requests on their own, and records every wake it is sent.
import * as fs from "node:fs";
import * as http from "node:http";

const seen = [];
function text(m) {
	return typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
}
function chunk(res, delta, finish = null) {
	res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}
http
	.createServer((req, res) => {
		let raw = "";
		req.on("data", d => (raw += d));
		req.on("end", () => {
			if (!req.url.includes("chat/completions")) {
				res.writeHead(200, { "content-type": "application/json" });
				return res.end(JSON.stringify({ data: [{ id: "mock", object: "model" }] }));
			}
			const body = JSON.parse(raw || "{}");
			const msgs = body.messages ?? [];
			const last = text(msgs.at(-1));
			for (const m of msgs) {
				const t = text(m);
				const at = t.indexOf("FIRSTMATE WATCHER WAKE: ");
				if (at < 0) continue;
				const wake = t.slice(at + 24).split(/\\n|\n/)[0];
				if (!seen.some(s => s.wake === wake)) seen.push({ role: m.role, wake });
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (last.includes("<title-request>")) {
				chunk(res, { role: "assistant", content: "Wake test" });
				chunk(res, {}, "stop");
			} else if (last.includes("arm the watcher") && msgs.at(-1).role === "user") {
				chunk(res, { role: "assistant", tool_calls: [{ index: 0, id: "call_arm", type: "function", function: { name: "fm_watch_arm_omp", arguments: "{}" } }] });
				chunk(res, {}, "tool_calls");
			} else {
				chunk(res, { role: "assistant", content: "Drained and handled the wake." });
				chunk(res, {}, "stop");
			}
			res.write("data: [DONE]\n\n");
			res.end();
			fs.writeFileSync(process.env.WAKE_LOG, JSON.stringify(seen, null, 1));
		});
	})
	.listen(Number(process.env.PORT ?? 18092), "127.0.0.1");
