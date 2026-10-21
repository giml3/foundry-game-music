// Pregenerate a library of long lively plucky-lute interludes (strumming / drumming)
// for Bardic Dice, so a marathon session never waits on live generation
// for its bridges and the GPU stays free for dice-steered vocal songs.
//
// Sizing: 24 hours needs 144 x 10-min (or 288 x 5-min) tracks for zero
// repeats. The default plan is 48 tracks of 5-10 minutes (~6 h unique):
// over 24 h each interlude returns about four times, hours apart — and
// bridges share the clock with vocal songs, so repeats land even rarer.
// Raise --count toward 144 if you want a no-repeat day.
//
// Usage (ACE-Step sidecar must be running):
//   node sidecar/pregenerate-bridges.mjs --out <FoundryData>/bardic-dice/library
//   node sidecar/pregenerate-bridges.mjs --count 48 --ace http://127.0.0.1:8001
// Resumable: existing files are skipped; manifest.json is updated per track.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AceStepClient } from "../scripts/ace-client.js";
import { buildBridgeRequest, planLibraryTracks } from "../scripts/prompt-engine.js";
import { Mode } from "../scripts/constants.js";

const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const count = Number(argVal("count", "48"));
const start = Number(argVal("start", "0"));
const outDir = argVal("out", "bardic-dice/library");
const aceUrl = argVal("ace", "http://127.0.0.1:8001");
const model = argVal("model", "acestep-v15-turbo");
const quiet = args.includes("--quiet");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(outDir, { recursive: true });
const manifestPath = join(outDir, "manifest.json");
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : { version: 1, tracks: [] };
const byFile = new Map((manifest.tracks ?? []).map((t) => [t.file, t]));

const client = new AceStepClient({ baseUrl: aceUrl, timeoutMs: 60000 });
if (!(await client.healthCheck())) {
  console.error(`ACE-Step unreachable at ${aceUrl} — start the sidecar first (sidecar/start-api.sh).`);
  process.exit(1);
}

const plan = planLibraryTracks(count).slice(start);
const totalSec = plan.reduce((a, t) => a + t.duration, 0);
if (!quiet) console.log(`Plan: ${plan.length} interludes, ${(totalSec / 3600).toFixed(1)} h of unique audio -> ${outDir}`);

let done = 0;
let generatedSec = 0;
let wallSec = 0;
const failed = [];
for (const item of plan) {
  const file = `bridge-${String(item.index).padStart(3, "0")}-${item.flavor}.mp3`;
  const dest = join(outDir, file);
  if (existsSync(dest) && byFile.has(file)) {
    if (!quiet) console.log(`[${item.index}] skip ${file} (already generated)`);
    continue;
  }
  const req = buildBridgeRequest({ mode: Mode.TAVERN, flavor: item.flavor, bridgeDuration: item.duration, bridgeIndex: 0, varietySeed: item.seed });
  req.bpm = item.bpm;
  req.keyScale = item.keyScale;
  req.duration = item.duration;
  const t0 = Date.now();
  if (!quiet) process.stdout.write(`[${item.index}] ${file} ${item.flavor} ${item.duration}s ${item.bpm} BPM ${item.keyScale} ... `);
  let out;
  try {
    out = await client.generate({
      prompt: req.prompt, lyrics: req.lyrics, bpm: req.bpm, keyScale: req.keyScale,
      timeSignature: req.timeSignature, duration: req.duration,
      model, inferenceSteps: 8, thinking: false, vocalLanguage: "en",
      useFormat: true, seed: item.seed,
    }, { timeoutMs: 20 * 60 * 1000 });
  } catch (e) {
    // Unsupervised: wait out a sidecar hiccup once, then skip the track
    // (a rerun resumes it) instead of aborting the whole batch.
    console.error(`[${item.index}] ${file} failed (${e?.message ?? e}); retrying once in 30s`);
    await sleep(30000);
    try {
      out = await client.generate({
        prompt: req.prompt, lyrics: req.lyrics, bpm: req.bpm, keyScale: req.keyScale,
        timeSignature: req.timeSignature, duration: req.duration,
        model, inferenceSteps: 8, thinking: false, vocalLanguage: "en",
        useFormat: true, seed: item.seed,
      }, { timeoutMs: 20 * 60 * 1000 });
    } catch (e2) {
      console.error(`[${item.index}] ${file} SKIPPED after retry (${e2?.message ?? e2})`);
      failed.push(file);
      continue;
    }
  }
  const buf = Buffer.from(await out.blob.arrayBuffer());
  writeFileSync(dest, buf);
  const took = (Date.now() - t0) / 1000;
  done += 1;
  generatedSec += item.duration;
  wallSec += took;
  byFile.set(file, { file, title: "Plucky Interlude", flavor: item.flavor, duration: item.duration, bpm: item.bpm, keyScale: item.keyScale, styleId: item.styleId, progression: item.progression, loopForm: req.loopForm ?? item.loopForm, loopSections: req.loopSections ?? item.loopSections, loopHook: req.loopHook ?? item.loopHook, seed: item.seed });
  manifest.tracks = [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const rate = generatedSec / Math.max(1, wallSec);
  const remainAudio = plan.slice(plan.indexOf(item) + 1).reduce((a, t) => a + (existsSync(join(outDir, `bridge-${String(t.index).padStart(3, "0")}-${t.flavor}.mp3`)) ? 0 : t.duration), 0);
  if (!quiet) console.log(`ok ${(buf.length / 1048576).toFixed(1)} MB in ${took.toFixed(0)}s (${rate.toFixed(2)}x realtime, ~${(remainAudio / Math.max(0.01, rate) / 60).toFixed(0)} min left)`);
}
console.log(`Done: ${done} new, ${manifest.tracks.length} total (${(manifest.tracks.reduce((a, t) => a + t.duration, 0) / 3600).toFixed(1)} h)${failed.length ? `, failed: ${failed.join(", ")}` : ""}.`);
