// Fake ACE-Step 1.5 API server for tests and Foundry testing without a GPU.
//   node tests/mock-ace-server.mjs          (listens on :8001)
//   import { createMockAceServer } from "./mock-ace-server.mjs"  (tests)
// Implements the documented wrapper: {data, code:200, error, timestamp}.
// A prompt containing "__FAIL__" produces a failed task (status 2).
import http from "node:http";
import { pathToFileURL } from "node:url";

function makeToneWav(seconds = 3, freq = 392) {
  const sr = 22050;
  const n = Math.floor(sr * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.min(1, Math.min(i, n - i) / (sr * 0.2));
    const v = env * 0.5 * (Math.sin(2 * Math.PI * freq * t) + 0.4 * Math.sin(2 * Math.PI * freq * 1.5 * t));
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  return buf;
}

export function createMockAceServer({ apiKey = "" } = {}) {
  const tasks = new Map();
  let seq = 0;
  const wrap = (res, data, code = 200) => {
    res.writeHead(code === 200 ? 200 : 400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ data, code, error: code === 200 ? null : String(data), timestamp: Date.now(), extra: null }));
  };
  const readJson = (req) => new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => { s += c; });
    req.on("end", () => { try { resolve(JSON.parse(s || "{}")); } catch { resolve({}); } });
  });

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://localhost");
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" });
      return res.end();
    }
    if (apiKey && req.headers.authorization !== `Bearer ${apiKey}`) return wrap(res, "unauthorized", 401);
    if (u.pathname === "/health") return wrap(res, { status: "ok", service: "ACE-Step API (mock)", version: "mock" });
    if (u.pathname === "/v1/models") return wrap(res, { models: [{ name: "acestep-v15-turbo", is_default: true }], default_model: "acestep-v15-turbo" });
    if (u.pathname === "/v1/stats") return wrap(res, { jobs: { total: tasks.size, queued: 0, running: 0, succeeded: 0, failed: 0 }, queue_size: 0, avg_job_seconds: 0.1 });
    if (u.pathname === "/release_task" && req.method === "POST") {
      const body = await readJson(req);
      const id = `mock-task-${++seq}`;
      tasks.set(id, { body, polls: 0 });
      return wrap(res, { task_id: id, status: "queued", queue_position: 1 });
    }
    if (u.pathname === "/query_result" && req.method === "POST") {
      const body = await readJson(req);
      const ids = body.task_id_list ?? [];
      const out = ids.map((id) => {
        const t = tasks.get(id);
        if (!t) return { task_id: id, status: 2, result: "" };
        t.polls += 1;
        if (String(t.body.prompt ?? "").includes("__FAIL__")) return { task_id: id, status: 2, result: "" };
        if (t.polls < 2) return { task_id: id, status: 0, result: "" };
        const result = [{
          file: "/v1/audio?path=%2Ftmp%2Fapi_audio%2Fmock.mp3", wave: "", status: 1,
          create_time: Math.floor(Date.now() / 1000), env: "mock",
          prompt: t.body.prompt ?? "", lyrics: t.body.lyrics ?? "",
          metas: { bpm: t.body.bpm ?? 100, duration: t.body.audio_duration ?? 30, genres: "", keyscale: t.body.key_scale ?? "G Major", timesignature: t.body.time_signature ?? "4" },
          generation_info: "mock", seed_value: "42", lm_model: "acestep-5Hz-lm-0.6B", dit_model: t.body.model ?? "acestep-v15-turbo",
        }];
        return { task_id: id, status: 1, result: JSON.stringify(result) };
      });
      return wrap(res, out);
    }
    if (u.pathname === "/v1/audio") {
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Access-Control-Allow-Origin": "*" });
      return res.end(makeToneWav());
    }
    return wrap(res, "not found", 404);
  });
  server.mockTasks = tasks;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MOCK_ACE_PORT ?? 8001);
  createMockAceServer({ apiKey: process.env.MOCK_ACE_KEY ?? "" }).listen(port, "127.0.0.1", () => {
    console.log(`mock ACE-Step on http://127.0.0.1:${port} (GET /health, POST /release_task, POST /query_result, GET /v1/audio)`);
  });
}
