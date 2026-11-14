export class ApiError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const MAX_RESPONSE_BYTES = 1048576;

async function readJson(response) {
  const chunks = [];
  let size = 0;
  if (!response.body) throw new ApiError("invalid");
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await response.body.cancel();
      throw new ApiError("invalid");
    }
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ApiError("invalid"); }
}

// Leave the host a slice of its gateway budget so a slow recall fails open
// instead of being killed mid-flight. The reserve scales with small budgets:
// a fixed 200 ms reserve would exceed a 100 ms gateway budget entirely.
export function recallTimeoutMs(gatewayTimeoutMs) {
  const reserve = Math.min(200, Math.max(10, Math.floor(gatewayTimeoutMs / 10)));
  return Math.max(50, gatewayTimeoutMs - reserve);
}

export function authHeaders(config) {
  if (!config?.api_key) return {};
  return { [config.api_key_header]: `${config.api_key_prefix}${config.api_key}` };
}

export class Hindsight {
  constructor(config, fetcher = fetch) {
    this.config = config;
    this.fetcher = fetcher;
  }

  async request(path, payload, { signal, timeoutMs }) {
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([deadline, signal]) : deadline;
    let response;
    try {
      response = await this.fetcher(`${this.config.hindsight_api}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "magpie-hindsight/0.2.0",
          ...authHeaders(this.config)
        },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: combined
      });
    } catch { throw new ApiError("unavailable"); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ApiError([401, 403].includes(response.status) ? "unauthorized" : response.status >= 500 || response.status === 429 ? "unavailable" : "invalid");
    }
    return readJson(response);
  }

  async recall(query, signal) {
    const path = `/v1/default/banks/${encodeURIComponent(this.config.bank)}/memories/recall`;
    const data = await this.request(path, {
      query,
      max_tokens: this.config.recall_max_tokens,
      budget: "low",
      include: { entities: null, chunks: null, source_facts: null }
    }, { signal, timeoutMs: recallTimeoutMs(this.config.gatewayTimeoutMs) });
    if (!Array.isArray(data.results)) throw new ApiError("invalid");
    return data.results.flatMap(result => typeof result?.text === "string" && result.text.trim() ? [result.text] : []);
  }

  async retain(query, answer, documentId, agent, protocol, signal) {
    const path = `/v1/default/banks/${encodeURIComponent(this.config.bank)}/memories`;
    return this.request(path, {
      items: [{
        content: `User:\n${query}\n\nAssistant:\n${answer}`,
        context: "Magpie gateway conversation turn",
        document_id: documentId,
        metadata: {
          source: "magpie-hindsight",
          agent: String(agent || "unknown").slice(0, 80),
          protocol: String(protocol || "unknown").slice(0, 32)
        }
      }],
      async: true
    }, { signal, timeoutMs: 10000 });
  }
}
