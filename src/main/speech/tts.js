'use strict';
/**
 * Text to speech, via the macOS `say` command — offline, already installed, and
 * able to use any voice the system has.
 *
 * We synthesise to a WAV file rather than letting `say` play it directly. That
 * costs a few hundred milliseconds but buys two things: the renderer can run the
 * audio through an AnalyserNode so the animation reacts to Verity's actual
 * voice, and it can route playback to a chosen output device.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SAY = '/usr/bin/say';

/** Voices macOS lists but which are jokes or sound effects rather than speech. */
const NOVELTY = new Set([
  'Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos', 'Deranged',
  'Good News', 'Jester', 'Organ', 'Superstar', 'Trinoids', 'Whisper', 'Wobble',
  'Zarvox', 'Hysterical', 'Bruce', 'Junior', 'Ralph', 'Kathy', 'Fred', 'Princess',
]);

function listVoices() {
  return new Promise((resolve) => {
    execFile(SAY, ['-v', '?'], { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve([]);
        return;
      }
      const voices = [];
      for (const line of stdout.split('\n')) {
        // Format: "Name<spaces>locale<spaces># sample sentence"
        const m = line.match(/^(.+?)\s{2,}([a-z]{2}(?:[-_][A-Z]{2})?)\s+#\s*(.*)$/);
        if (!m) continue;
        const [, name, locale, sample] = m;
        voices.push({
          name: name.trim(),
          locale,
          sample: sample.trim(),
          english: /^en/.test(locale),
          novelty: NOVELTY.has(name.trim()),
        });
      }
      // English, real voices first — that is what almost everyone wants.
      voices.sort((a, b) => {
        if (a.english !== b.english) return a.english ? -1 : 1;
        if (a.novelty !== b.novelty) return a.novelty ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
      resolve(voices);
    });
  });
}

/**
 * Strip anything that should not be read aloud. Even with the system prompt
 * asking for plain prose, models slip in markdown, and "asterisk asterisk" in
 * the middle of a sentence is jarring.
 */
function speakable(text) {
  let s = String(text || '');
  s = s.replace(/```[\s\S]*?```/g, ' . ');
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/https?:\/\/\S+/g, ' link ');
  s = s.replace(/^\s{0,3}#{1,6}\s*/gm, '');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/\*([^*]+)\*/g, '$1');
  s = s.replace(/^\s*[-*+]\s+/gm, '');
  s = s.replace(/^\s*>\s?/gm, '');
  s = s.replace(/[*_~|#]+/g, ' ');
  // Emoji and pictographs are read as their unicode names, which is nonsense aloud.
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Synthesise `text` to a WAV file and return its path.
 * The caller owns the file and should delete it when playback finishes.
 */
function synthesise({ text, voice, rate, pitch }) {
  return new Promise((resolve, reject) => {
    let spoken = speakable(text);
    if (!spoken) {
      resolve(null);
      return;
    }

    // `say` reads [[...]] as embedded speech commands rather than aloud, so a
    // persona can raise the pitch without needing a different voice. Verified:
    // the same sentence takes the same time with and without the prefix.
    if (Number.isFinite(pitch) && pitch > 0) {
      spoken = `[[pbas ${Math.round(Math.max(20, Math.min(90, pitch)))}]] ${spoken}`;
    }

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const wav = path.join(os.tmpdir(), `verity-tts-${stamp}.wav`);
    // Passing the text through a file sidesteps argv length limits and any
    // chance of `say` reading text that begins with "-" as a flag.
    const txt = path.join(os.tmpdir(), `verity-tts-${stamp}.txt`);
    fs.writeFileSync(txt, spoken, 'utf8');

    const args = ['-o', wav, '--data-format=LEI16@22050', '--file-format=WAVE', '-f', txt];
    if (voice) args.unshift('-v', voice);
    if (rate) args.push('-r', String(rate));

    execFile(SAY, args, { timeout: 120000 }, (err) => {
      fs.unlink(txt, () => {});
      if (err) {
        reject(new Error(`Speech synthesis failed: ${err.message}`));
        return;
      }
      if (!fs.existsSync(wav)) {
        reject(new Error('Speech synthesis produced no audio.'));
        return;
      }
      resolve(wav);
    });
  });
}

module.exports = { synthesise, listVoices, speakable };
