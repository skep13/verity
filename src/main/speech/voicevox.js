'use strict';
/**
 * VOICEVOX speech backend.
 *
 * VOICEVOX (https://voicevox.hiroshiba.jp/) is a free Japanese text-to-speech
 * engine that runs entirely locally and exposes an HTTP API. It is a far better
 * fit for Verity than any cloud voice: nothing leaves the machine, there is no
 * account, and the character voices are the kind of bright, expressive speech
 * the macOS voices cannot do.
 *
 * Two honest limitations:
 *   It speaks Japanese only. Given English text it will read the letters, badly.
 *   Verity therefore only uses it when the language is set to Japanese.
 *   Each character voice carries its own usage terms — free for most uses with
 *   credit, but they differ per character. See TERMS_URL below.
 *
 * Synthesis is two calls: /audio_query turns text into a prosody structure, then
 * /synthesis renders that to WAV. The two-step design is what lets you adjust
 * speed and pitch, which is how the persona's settings are applied.
 */

const DEFAULT_HOST = 'http://127.0.0.1:50021';
const TERMS_URL = 'https://voicevox.hiroshiba.jp/term/';

function host() {
  // Required lazily: this module is loaded during app start, before config is warm.
  const { load } = require('../config');
  return load().voicevoxHost || DEFAULT_HOST;
}

/** Is a local engine answering? Cheap enough to call before every attempt. */
async function isRunning() {
  try {
    const res = await fetch(`${host()}/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function version() {
  try {
    const res = await fetch(`${host()}/version`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? (await res.text()).replace(/"/g, '').trim() : null;
  } catch {
    return null;
  }
}

/**
 * Available character voices, flattened to one entry per style.
 * VOICEVOX groups styles (normal, sweet, cheerful…) under a character; Verity
 * treats each style as a separate selectable voice, which is what it is.
 */
async function listVoices() {
  try {
    const res = await fetch(`${host()}/speakers`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const speakers = await res.json();
    const voices = [];
    for (const speaker of speakers) {
      for (const style of speaker.styles || []) {
        voices.push({
          id: style.id,
          name: `${speaker.name} — ${style.name}`,
          character: speaker.name,
          style: style.name,
        });
      }
    }
    return voices;
  } catch {
    return [];
  }
}

/**
 * Render text to WAV bytes.
 *
 * `pitch` arrives on the macOS `say` scale (roughly 40-62) because that is what
 * the persona defines; VOICEVOX wants an offset around 0, so it is remapped
 * rather than passed through, where it would be wildly out of range.
 */
async function synthesise({ text, speaker = 1, rate, pitch, signal }) {
  const spoken = String(text || '').trim();
  if (!spoken) return null;

  const base = host();

  // Step one: text to a prosody query.
  const queryUrl = `${base}/audio_query?speaker=${encodeURIComponent(speaker)}&text=${encodeURIComponent(spoken)}`;
  const queryRes = await fetch(queryUrl, { method: 'POST', signal });
  if (!queryRes.ok) {
    const detail = await queryRes.text().catch(() => '');
    throw new Error(`VOICEVOX could not read that text (${queryRes.status}): ${detail.slice(0, 160)}`);
  }
  const query = await queryRes.json();

  // `say` rates are words per minute around 190; VOICEVOX speedScale is a
  // multiplier around 1.0.
  if (Number.isFinite(rate) && rate > 0) {
    query.speedScale = Math.max(0.5, Math.min(2, rate / 190));
  }
  // pbas 50 is the persona's neutral, and VOICEVOX pitchScale is roughly -0.15
  // to 0.15 before it starts to sound broken.
  if (Number.isFinite(pitch)) {
    query.pitchScale = Math.max(-0.15, Math.min(0.15, (pitch - 50) / 100));
  }

  // Step two: render it.
  const synthRes = await fetch(`${base}/synthesis?speaker=${encodeURIComponent(speaker)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
    signal,
  });
  if (!synthRes.ok) {
    const detail = await synthRes.text().catch(() => '');
    throw new Error(`VOICEVOX synthesis failed (${synthRes.status}): ${detail.slice(0, 160)}`);
  }

  return Buffer.from(await synthRes.arrayBuffer());
}

module.exports = { isRunning, version, listVoices, synthesise, DEFAULT_HOST, TERMS_URL };
