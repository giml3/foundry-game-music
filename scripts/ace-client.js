// ACE-Step 1.5 REST client. Pure (injectable fetch/sleep) so it is unit-testable
// in Node against a mock server and usable unchanged in the Foundry browser client.
// API contract: POST /release_task -> {data:{task_id}}, POST /query_result
// {task_id_list:[...]} -> {data:[{task_id,status,result}]}, GET /v1/audio?path=...

export class AceStepError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = "AceStepError";
    this.status = status;
    this.code = code;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function normalizeBaseUrl(url) {
  const s = String(url ?? "").trim();
  return (s || "http://127.0.0.1:8001").replace(/\/+$/, "");
}

/** Resolve the `file` value from a task result into a downloadable URL. */
export function resolveAudioUrl(baseUrl, file) {
  const f = String(file ?? "").trim();
  if (!f) throw new AceStepError("ACE-Step result contained no audio file");
  if (/^https?:\/\//i.test(f)) return f;
  const base = normalizeBaseUrl(baseUrl);
  if (f.startsWith("/v1/audio")) return base + f;
  if (f.startsWith("/")) return `${base}/v1/audio?path=${encodeURIComponent(f)}`;
  if (f.includes("v1/audio")) return `${base}/${f.replace(/^\/+/, "")}`;
  return `${base}/v1/audio?path=${encodeURIComponent(f)}`;
}

/** Parse one /query_result entry's `result` (a JSON string) into result objects. */
export function parseTaskResults(entry) {
  if (!entry) return [];
  let raw = entry.result ?? entry.results ?? [];
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return [];
    try { raw = JSON.parse(t); } catch { return []; }
  }
  return Array.isArray(raw) ? raw : [raw];
}

export class AceStepClient {
  constructor({ baseUrl = "http://127.0.0.1:8001", apiKey = "", fetchImpl = null, sleep = null, timeoutMs = 30000 } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.apiKey = String(apiKey ?? "").trim();
    this.fetch = fetchImpl ?? ((...a) => globalThis.fetch(...a));
    this.sleep = sleep ?? defaultSleep;
    this.timeoutMs = timeoutMs;
  }

  #headers(extra = {}) {
    const h = { "Content-Type": "application/json", ...extra };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async #request(path, { method = "GET", body = null, raw = false } = {}) {
    const url = this.baseUrl + path;
    let signal;
    let timer;
    if (typeof AbortController !== "undefined" && this.timeoutMs > 0) {
      const c = new AbortController();
      signal = c.signal;
      timer = setTimeout(() => c.abort(), this.timeoutMs);
    }
    let res;
    try {
      res = await this.fetch(url, {
        method,
        headers: raw ? (this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) : this.#headers(),
        body: body == null ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (e) {
      throw new AceStepError(`ACE-Step unreachable at ${this.baseUrl} (${e?.message ?? e})`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (raw) {
      if (!res.ok) throw new AceStepError(`ACE-Step audio download failed: HTTP ${res.status}`, { status: res.status });
      return res;
    }
    let json;
    try { json = await res.json(); } catch { throw new AceStepError(`ACE-Step returned non-JSON (HTTP ${res.status})`, { status: res.status }); }
    if (!res.ok || (json && json.code != null && json.code !== 200)) {
      throw new AceStepError(json?.error || `ACE-Step request failed: HTTP ${res.status}`, { status: res.status, code: json?.code ?? null });
    }
    return json?.data ?? json;
  }

  /** @returns {Promise<boolean>} true when GET /health reports ok. Never throws. */
  async healthCheck() {
    try {
      const data = await this.#request("/health");
      return !data?.status || String(data.status).toLowerCase() === "ok";
    } catch { return false; }
  }

  /** @returns {Promise<string[]>} available DiT model names. */
  async listModels() {
    const data = await this.#request("/v1/models");
    const models = data?.models ?? [];
    return models.map((m) => (typeof m === "string" ? m : m?.name)).filter(Boolean);
  }

  /**
   * Submit a generation task.
   * @param {object} p {prompt, lyrics, bpm, keyScale, timeSignature, duration, model,
   *                    inferenceSteps, thinking, vocalLanguage, audioFormat, seed}
   * @returns {Promise<string>} task_id
   */
  async releaseTask(p = {}) {
    const body = {
      prompt: p.prompt ?? "",
      lyrics: p.lyrics ?? "",
      thinking: Boolean(p.thinking),
      vocal_language: "en", // English only — owner's rule, pinned at the API boundary
      audio_format: p.audioFormat ?? "mp3",
      inference_steps: p.inferenceSteps ?? 8,
      use_random_seed: p.seed == null,
      batch_size: 1,
    };
    if (p.model) body.model = p.model;
    if (p.bpm != null) body.bpm = Math.round(p.bpm);
    if (p.keyScale) body.key_scale = p.keyScale;
    if (p.timeSignature) body.time_signature = String(p.timeSignature);
    if (p.duration != null) body.audio_duration = Number(p.duration);
    if (p.seed != null) body.seed = p.seed;
    if (p.useFormat != null) body.use_format = Boolean(p.useFormat);
    const data = await this.#request("/release_task", { method: "POST", body });
    const taskId = data?.task_id ?? data?.taskId;
    if (!taskId) throw new AceStepError("ACE-Step /release_task returned no task_id");
    return taskId;
  }

  /** Query one task once. @returns {Promise<{taskId,status,results}>} status 0=running,1=ok,2=failed */
  async queryResult(taskId) {
    const data = await this.#request("/query_result", { method: "POST", body: { task_id_list: [taskId] } });
    const list = Array.isArray(data) ? data : [data];
    const entry = list.find((e) => e?.task_id === taskId) ?? list[0];
    if (!entry) return { taskId, status: 0, results: [] };
    return { taskId, status: Number(entry.status ?? 0), results: parseTaskResults(entry), raw: entry };
  }

  /**
   * Poll until success/failure/timeout. Generation takes seconds (turbo) to
   * >a minute (base/CPU), so the default budget is generous.
   */
  async waitForTask(taskId, { timeoutMs = 10 * 60 * 1000, pollMs = 2000, onPoll = null, signal = null } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) throw new AceStepError("ACE-Step generation aborted (superseded)");
      const q = await this.queryResult(taskId);
      if (onPoll) { try { onPoll(q); } catch { /* observer must not break polling */ } }
      if (q.status === 1) return q;
      if (q.status === 2) throw new AceStepError(`ACE-Step generation failed (task ${taskId})`);
      if (Date.now() >= deadline) throw new AceStepError(`ACE-Step generation timed out after ${Math.round(timeoutMs / 1000)}s (task ${taskId})`);
      await this.sleep(pollMs);
    }
  }

  /** Download generated audio. @returns {Promise<Blob>} */
  async fetchAudioBlob(file) {
    const url = resolveAudioUrl(this.baseUrl, file);
    const path = url.slice(this.baseUrl.length);
    const res = await this.#request(path, { raw: true });
    if (typeof res.blob === "function") return res.blob();
    const buf = await res.arrayBuffer();
    return new Blob([buf], { type: "audio/mpeg" });
  }

  /**
   * Full pipeline: submit -> wait -> download first result.
   * @returns {Promise<{blob: Blob, file: string, metas: object, lyrics: string, prompt: string, taskId: string}>}
   */
  async generate(params, waitOpts = {}) {
    const taskId = await this.releaseTask(params);
    const done = await this.waitForTask(taskId, waitOpts);
    const first = done.results.find((r) => r?.file) ?? done.results[0];
    if (!first?.file) throw new AceStepError("ACE-Step succeeded but returned no audio file");
    const blob = await this.fetchAudioBlob(first.file);
    return { blob, file: first.file, metas: first.metas ?? {}, lyrics: first.lyrics ?? params.lyrics ?? "", prompt: first.prompt ?? params.prompt ?? "", taskId };
  }
}
