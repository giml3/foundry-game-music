import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sh = ["setup-llm.sh", "start-llm.sh", "start-all.sh", "start-api.sh", "start-api-macos.sh", "start-parody.sh"];
const bat = ["setup-llm.bat", "start-llm.bat", "start-api.bat", "start-parody.bat"];

test("LLM + ACE-Step sidecar scripts exist for every platform", () => {
  for (const f of [...sh, ...bat]) assert.ok(existsSync(join(root, "sidecar", f)), f);
});

test("shell scripts are executable and pass bash -n", () => {
  for (const f of sh) {
    const p = join(root, "sidecar", f);
    assert.ok(statSync(p).mode & 0o100, `${f} must be user-executable`);
    const r = spawnSync("bash", ["-n", p], { encoding: "utf8" });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

test("setup-llm installs Ollama, pulls the same default model as the module setting, smoke-tests /v1", () => {
  const setup = readFileSync(join(root, "sidecar", "setup-llm.sh"), "utf8");
  const settings = readFileSync(join(root, "scripts", "settings.js"), "utf8");
  const modelInSetup = setup.match(/BARDIC_LLM_MODEL:-([a-z0-9.:-]+)/)?.[1];
  assert.ok(modelInSetup, "setup script must default the model");
  assert.ok(settings.includes(`default: "${modelInSetup}"`), `module default must be ${modelInSetup}`);
  assert.match(setup, /ollama\.com\/install\.sh|brew install ollama/);
  assert.match(setup, /ollama pull/);
  assert.match(setup, /\/v1\/chat\/completions/);
  assert.match(setup, /127\.0\.0\.1:11434/);
  const setupBat = readFileSync(join(root, "sidecar", "setup-llm.bat"), "utf8");
  assert.ok(setupBat.includes(modelInSetup), "bat must default the same model");
  assert.match(setupBat, /winget install.*Ollama/i);
});

test("start-all launches the parody core writer when the LRCLIB db is present", () => {
  const all = readFileSync(join(root, "sidecar", "start-all.sh"), "utf8");
  assert.match(all, /parody-writer\.mjs/);
  assert.match(all, /lrclib\.sqlite3/);
  assert.match(all, /8123/);
});

test("start-all logs every service into sidecar/logs", () => {
  const all = readFileSync(join(root, "sidecar", "start-all.sh"), "utf8");
  assert.match(all, /bardic-ace\.log/);
  assert.match(all, /bardic-parody\.log/);
  assert.match(all, /bardic-ollama\.log/);
  assert.match(all, /tee -a/, "ACE output must be tee'd to its log file");
});

test("start scripts keep Ollama bound to localhost", () => {
  assert.match(readFileSync(join(root, "sidecar", "start-llm.sh"), "utf8"), /127\.0\.0\.1:11434/);
  assert.match(readFileSync(join(root, "sidecar", "start-llm.bat"), "utf8"), /127\.0\.0\.1:11434/);
});
