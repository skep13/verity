'use strict';
/**
 * Speech to text, via whisper.cpp running locally.
 *
 * The renderer hands us raw 16 kHz mono PCM that it captured and downsampled
 * itself, so there is no ffmpeg dependency anywhere in the chain — we only have
 * to bolt a WAV header on and hand the file to whisper-cli.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { app } = require('electron');
const { load } = require('../config');

const BINARY_CANDIDATES = ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli', 'whisper-cli'];

function binaryPath() {
  for (const candidate of BINARY_CANDIDATES) {
    if (candidate.includes('/') && fs.existsSync(candidate)) return candidate;
  }
  // Fall back to PATH lookup and let execFile report a clear failure.
  return 'whisper-cli';
}

function resolveModel(name) {
  const candidates = [
    path.join(process.resourcesPath || '', 'models', name),
    path.join(app.getAppPath(), 'models', name),
    path.join(__dirname, '..', '..', '..', 'models', name),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * The model ships beside the app when packaged, and in ./models in development.
 *
 * Anything other than English needs the multilingual model: ggml-base.en.bin is
 * English-only and, given Japanese, returns fluent-looking English nonsense
 * rather than an error — the worst possible failure for a transcriber.
 */
function modelPath() {
  const cfg = load();
  const language = cfg.language || 'en';
  if (language !== 'en') {
    const multilingual = resolveModel('ggml-base.bin');
    if (multilingual) return multilingual;
    // Fall through to the English model only so the app still starts; transcribe()
    // refuses to use it for another language rather than producing rubbish.
  }
  return resolveModel(cfg.stt.model || 'ggml-base.en.bin');
}

function available() {
  return Boolean(modelPath());
}

/** True when the current language can actually be transcribed. */
function languageSupported() {
  const language = load().language || 'en';
  if (language === 'en') return Boolean(resolveModel('ggml-base.en.bin') || resolveModel('ggml-base.bin'));
  return Boolean(resolveModel('ggml-base.bin'));
}

/** Wrap signed 16-bit mono PCM in a WAV container. */
function wavFromPcm(pcm, sampleRate = 16000) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(1, 22); // channels
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * whisper-cli writes progress and backend chatter to stderr, but a few builds
 * leak informational lines onto stdout. Drop anything that looks like logging
 * and anything whisper emits for silence.
 */
const NOISE = /^\s*(\[|load_backend|whisper_|read_audio_data|main:|ggml_|system_info|\(.*\)\s*$)/;
const NON_SPEECH = /^\s*[\[(](BLANK_AUDIO|blank_audio|silence|Music|MUSIC|inaudible)[\])]\s*$/i;

function clean(stdout) {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !NOISE.test(l) && !NON_SPEECH.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Transcribe raw PCM. Returns '' when the clip holds no speech, which is the
 * normal outcome for an accidental tap of the mic button.
 */
function transcribe(pcmBuffer, sampleRate = 16000) {
  return new Promise((resolve, reject) => {
    const language = load().language || 'en';
    const model = modelPath();
    if (!model) {
      reject(new Error("The speech model is missing. Expected ggml-base.en.bin in Verity's models folder."));
      return;
    }
    if (language !== 'en' && /\.en\.bin$/.test(model)) {
      reject(
        new Error(
          `Listening in ${language} needs the multilingual speech model. Download ggml-base.bin into Verity's models folder, or switch the language back to English.`
        )
      );
      return;
    }
    // Under ~0.25s there is nothing worth sending to whisper.
    if (!pcmBuffer || pcmBuffer.length < sampleRate * 0.5) {
      resolve('');
      return;
    }

    const file = path.join(os.tmpdir(), `verity-${Date.now()}.wav`);
    fs.writeFileSync(file, wavFromPcm(pcmBuffer, sampleRate));

    const args = [
      '-m', model,
      '-f', file,
      '-t', String(load().stt.threads || 4),
      '-nt',  // no timestamps
      '-np',  // no progress prints
    ];
    // Pin the language rather than letting whisper guess: auto-detection on a
    // short clip frequently picks the wrong one and translates instead.
    if (!/\.en\.bin$/.test(model)) args.push('-l', language);

    execFile(binaryPath(), args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      fs.unlink(file, () => {});
      if (err) {
        if (err.code === 'ENOENT') {
          reject(new Error('whisper-cli is not installed. Run: brew install whisper-cpp'));
        } else {
          reject(new Error(`Transcription failed: ${(stderr || err.message).slice(0, 300)}`));
        }
        return;
      }
      resolve(clean(stdout));
    });
  });
}

module.exports = { transcribe, available, languageSupported, modelPath, wavFromPcm };
