'use strict';
/**
 * Ollama provider.
 *
 * Deliberately model-agnostic: the picker shows whatever `ollama list` reports,
 * so pulling a new model makes it available without touching this file.
 */

const { load } = require('../config');

function host() {
  return load().ollamaHost;
}

/** Reasoning models emit <think> blocks that should never reach the UI or the voice. */
const THINKING_FAMILIES = /^(qwen3|deepseek-r1|gpt-oss|magistral|phi4-reasoning)/i;

function supportsThinking(model) {
  return THINKING_FAMILIES.test(String(model || ''));
}

/**
 * Normalise keep_alive for Ollama.
 *
 * Ollama accepts either a JSON number (seconds, where -1 means "never unload"
 * and 0 means "unload immediately") or a duration *string* that carries a unit,
 * such as "30s" or "5m". A bare numeric string is neither: it is parsed as a
 * duration and rejected with `missing unit in duration "-1"`. The settings menu
 * hands us strings for every option, so the numeric ones are converted back.
 */
function keepAliveValue(raw) {
  if (raw === undefined || raw === null || raw === '') return '5m';
  if (typeof raw === 'number') return raw;
  const value = String(raw).trim();
  return /^-?\d+$/.test(value) ? Number(value) : value;
}

async function isRunning() {
  try {
    const res = await fetch(`${host()}/api/tags`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function listModels() {
  const res = await fetch(`${host()}/api/tags`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`Ollama responded ${res.status}`);
  const data = await res.json();
  return (data.models || []).map((m) => ({
    id: m.name,
    label: m.name,
    provider: 'ollama',
    bytes: m.size || 0,
    parameters: m.details?.parameter_size || null,
  }));
}

/** Our neutral tool schema -> Ollama's OpenAI-style function format. */
function toOllamaTool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}

/** Iterate newline-delimited JSON objects from a fetch response body. */
async function* ndjson(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        /* partial or malformed line: skip it */
      }
    }
  }
  const tail = buffer.trim();
  if (tail) {
    try {
      yield JSON.parse(tail);
    } catch {
      /* ignore */
    }
  }
}

/**
 * One assistant turn. Streams text through onToken and returns the finished
 * message, including any tool calls the model asked for.
 */
async function chat({ model, messages, tools, onToken, signal, numCtx }) {
  const cfg = load();
  const build = (withThink) => {
    const body = {
      model,
      messages,
      stream: true,
      // How long Ollama keeps the model resident after the reply. The default is
      // 5 minutes, which on 8GB means a couple of gigabytes stay pinned while you
      // are back in your browser. Dropping it trades a few seconds of reload on
      // the next question for that memory back.
      keep_alive: keepAliveValue(cfg.ollamaKeepAlive),
      options: {
        // Context is capped deliberately: KV cache is the memory that bites on
        // an 8GB machine, and it grows linearly with this number.
        num_ctx: numCtx || cfg.numCtx || 8192,
        temperature: 0.6,
      },
    };
    if (tools && tools.length) body.tools = tools.map(toOllamaTool);
    // Thinking costs tokens and latency we can't spare locally.
    if (withThink) body.think = false;
    return body;
  };

  let res = await fetch(`${host()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(build(supportsThinking(model))),
    signal,
  });

  // Older Ollama builds, and non-reasoning models, reject the `think` field.
  if (!res.ok && res.status === 400) {
    res = await fetch(`${host()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(build(false)),
      signal,
    });
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Ollama error ${res.status}: ${detail.slice(0, 300)}`);
  }

  let content = '';
  const toolCalls = [];
  let inThink = false;

  for await (const chunk of ndjson(res.body)) {
    if (chunk.error) throw new Error(`Ollama: ${chunk.error}`);
    const msg = chunk.message;
    if (!msg) continue;

    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const fn = tc.function || {};
        let args = fn.arguments;
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            args = {};
          }
        }
        toolCalls.push({ id: tc.id || `call_${toolCalls.length}`, name: fn.name, input: args || {} });
      }
    }

    let piece = msg.content || '';
    if (!piece) continue;

    // Strip reasoning blocks defensively — some builds emit them even with
    // think:false, and they must not be spoken aloud.
    if (inThink) {
      const end = piece.indexOf('</think>');
      if (end === -1) continue;
      piece = piece.slice(end + 8);
      inThink = false;
    }
    const start = piece.indexOf('<think>');
    if (start !== -1) {
      const end = piece.indexOf('</think>', start);
      if (end === -1) {
        piece = piece.slice(0, start);
        inThink = true;
      } else {
        piece = piece.slice(0, start) + piece.slice(end + 8);
      }
    }
    if (!piece) continue;

    content += piece;
    if (onToken) onToken(piece);
  }

  return { content: content.trim(), toolCalls };
}

module.exports = { listModels, isRunning, chat, supportsThinking, keepAliveValue };
