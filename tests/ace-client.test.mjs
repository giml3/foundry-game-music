import test from "node:test";
import assert from "node:assert/strict";
import { AceStepClient, normalizeBaseUrl, parseTaskResults, resolveAudioUrl } from "../scripts/ace-client.js";
import { createMockAceServer } from "./mock-ace-server.mjs";

test("normalizeBaseUrl and resolveAudioUrl handle the documented shapes", () => {
  assert.equal(normalizeBaseUrl("http://127.0.0.1:8001/"), "http://127.0.0.1:8001");
  assert.equal(normalizeBaseUrl(""), "http://127.0.0.1:8001");
  assert.equal(resolveAudioUrl("http://h:8001", "/v1/audio?path=%2Ftmp%2Fa.mp3"), "http://h:8001/v1/audio?path=%2Ftmp%2Fa.mp3");
  assert.equal(resolveAudioUrl("http://h:8001", "/tmp/a b.mp3"), "http://h:8001/v1/audio?path=%2Ftmp%2Fa%20b.mp3");
  assert.equal(resolveAudioUrl("http://h:8001", "https://cdn/x.mp3"), "https://cdn/x.mp3");
});

test("parseTaskResults parses the JSON-string result field", () => {
  const entry = { status: 1, result: JSON.stringify([{ file: "/v1/audio?path=x", metas: { bpm: 120 } }]) };
  assert.equal(parseTaskResults(entry)[0].metas.bpm, 120);
  assert.deepEqual(parseTaskResults({ result: "" }), []);
  assert.deepEqual(parseTaskResults({ result: "not json" }), []);
});

test("releaseTask sends snake_case ACE-Step fields", async () => {
  let seen;
  const client = new AceStepClient({
    fetchImpl: async (url, opts) => {
      seen = { url, body: JSON.parse(opts.body) };
      return { ok: true, status: 200, json: async () => ({ data: { task_id: "t1" }, code: 200, error: null }) };
    },
  });
  const id = await client.releaseTask({ prompt: "tavern", lyrics: "la", bpm: 120.4, keyScale: "G Major", timeSignature: "3", duration: 90, model: "acestep-v15-turbo", inferenceSteps: 8, thinking: true });
  assert.equal(id, "t1");
  assert.match(seen.url, /\/release_task$/);
  assert.equal(seen.body.bpm, 120);
  assert.equal(seen.body.key_scale, "G Major");
  assert.equal(seen.body.time_signature, "3");
  assert.equal(seen.body.audio_duration, 90);
  assert.equal(seen.body.batch_size, 1);
});

test("healthCheck never throws on a dead server", async () => {
  const client = new AceStepClient({ baseUrl: "http://127.0.0.1:9", timeoutMs: 500 });
  assert.equal(await client.healthCheck(), false);
});

test("full generate() against the mock ACE-Step server", async (t) => {
  const server = createMockAceServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = new AceStepClient({ baseUrl: base });
  assert.equal(await client.healthCheck(), true);
  assert.deepEqual(await client.listModels(), ["acestep-v15-turbo"]);
  const out = await client.generate(
    { prompt: "bawdy tavern", lyrics: "[Verse] hi", bpm: 110, keyScale: "D major", duration: 60 },
    { pollMs: 5 });
  assert.equal(out.metas.bpm, 110);
  assert.ok(out.blob.size > 1000, "audio bytes downloaded");
  const sent = [...server.mockTasks.values()][0].body;
  assert.equal(sent.prompt, "bawdy tavern");
  await assert.rejects(
    client.generate({ prompt: "__FAIL__" }, { pollMs: 5 }),
    /generation failed/);
});

test("api key is sent as a bearer token", async (t) => {
  const server = createMockAceServer({ apiKey: "sekret" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await new AceStepClient({ baseUrl: base }).healthCheck(), false);
  assert.equal(await new AceStepClient({ baseUrl: base, apiKey: "sekret" }).healthCheck(), true);
});
