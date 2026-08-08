'use strict';
/**
 * Claude provider — optional. Verity works entirely offline without it; adding
 * a key just gives you a stronger model when you happen to have a connection.
 *
 * The key is read from the Keychain at call time and never leaves the main process.
 */

const { load, getClaudeKey } = require('../config');

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

const MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5 — most capable' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — balanced' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 — fastest' },
];

function listModels() {
  return MODELS.map((m) => ({ ...m, provider: 'claude' }));
}

/** Our neutral tool schema is already Claude's shape. */
function toClaudeTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  };
}

/**
 * Convert the neutral transcript into Claude's content-block format.
 * Tool results are user-turn blocks in Claude, not their own role.
 */
function toClaudeMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') continue;

    if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: String(m.content ?? ''),
      };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
      continue;
    }

    if (m.role === 'assistant' && m.tool_calls?.length) {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input || {} });
      }
      out.push({ role: 'assistant', content });
      continue;
    }

    if (!m.content) continue;
    out.push({ role: m.role, content: String(m.content) });
  }
  return out;
}

/** Iterate SSE `data:` payloads from a fetch response body. */
async function* sse(body) {
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
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        yield JSON.parse(payload);
      } catch {
        /* skip malformed event */
      }
    }
  }
}

async function chat({ model, messages, tools, onToken, signal }) {
  const key = getClaudeKey();
  if (!key) throw new Error('No Claude API key is saved. Add one in Settings, or switch to a local model.');

  const system = messages.find((m) => m.role === 'system')?.content;

  const body = {
    model: model || load().claudeModel,
    max_tokens: 2048,
    stream: true,
    messages: toClaudeMessages(messages),
  };
  if (system) body.system = system;
  if (tools && tools.length) body.tools = tools.map(toClaudeTool);

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    let message = detail.slice(0, 300);
    try {
      message = JSON.parse(detail).error?.message || message;
    } catch {
      /* keep raw text */
    }
    throw new Error(`Claude API ${res.status}: ${message}`);
  }

  let content = '';
  const toolCalls = [];
  // Tool inputs stream in as JSON fragments keyed by content-block index.
  const partial = new Map();

  for await (const ev of sse(res.body)) {
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
      partial.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, json: '' });
    } else if (ev.type === 'content_block_delta') {
      const d = ev.delta || {};
      if (d.type === 'text_delta' && d.text) {
        content += d.text;
        if (onToken) onToken(d.text);
      } else if (d.type === 'input_json_delta') {
        const slot = partial.get(ev.index);
        if (slot) slot.json += d.partial_json || '';
      }
    } else if (ev.type === 'content_block_stop') {
      const slot = partial.get(ev.index);
      if (slot) {
        let input = {};
        try {
          input = slot.json ? JSON.parse(slot.json) : {};
        } catch {
          input = {};
        }
        toolCalls.push({ id: slot.id, name: slot.name, input });
        partial.delete(ev.index);
      }
    } else if (ev.type === 'error') {
      throw new Error(`Claude API: ${ev.error?.message || 'stream error'}`);
    }
  }

  return { content: content.trim(), toolCalls };
}

module.exports = { listModels, chat, MODELS };
