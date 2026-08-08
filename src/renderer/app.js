'use strict';
/**
 * Renderer orchestration.
 *
 * Audio lives here rather than in the main process because the animation has to
 * track the sound: the orb is driven by FFT data from the microphone while you
 * talk and from Verity's own voice while it answers.
 *
 * Listening is hands-free. The microphone stays open and a voice-activity
 * detector decides when you have started and stopped speaking, so there is
 * nothing to press and hold.
 */

const $ = (id) => document.getElementById(id);

const el = {
  orb: $('orb'),
  stateLabel: $('stateLabel'),
  statusbar: $('statusbar'),
  messages: $('messages'),
  emptyState: $('emptyState'),
  input: $('input'),
  mic: $('mic'),
  send: $('send'),
  stop: $('stop'),
  newChat: $('newChat'),
  settingsBtn: $('settingsBtn'),
  settings: $('settings'),
  closeSettings: $('closeSettings'),
  scrim: $('scrim'),
  persona: $('persona'),
  language: $('language'),
  personaHint: $('personaHint'),
  brandName: document.querySelector('.brand h1'),
  provider: $('provider'),
  model: $('model'),
  modelHint: $('modelHint'),
  voiceModel: $('voiceModel'),
  keepAlive: $('keepAlive'),
  numCtx: $('numCtx'),
  autoSpeak: $('autoSpeak'),
  autoListen: $('autoListen'),
  wakeEnabled: $('wakeEnabled'),
  wakePhrase: $('wakePhrase'),
  briefEnabled: $('briefEnabled'),
  briefTime: $('briefTime'),
  loginItem: $('loginItem'),
  homeLocation: $('homeLocation'),
  testBrief: $('testBrief'),
  saveConversations: $('saveConversations'),
  voice: $('voice'),
  rate: $('rate'),
  outputDevice: $('outputDevice'),
  testVoice: $('testVoice'),
  permissions: $('permissions'),
  vaultPath: $('vaultPath'),
  vaultFolder: $('vaultFolder'),
  revealVault: $('revealVault'),
  zimStatus: $('zimStatus'),
  claudeKey: $('claudeKey'),
  saveKey: $('saveKey'),
  clearKey: $('clearKey'),
  approval: $('approval'),
  approvalTitle: $('approvalTitle'),
  approvalArgs: $('approvalArgs'),
  approvalRemember: $('approvalRemember'),
  approvalAllow: $('approvalAllow'),
  approvalDeny: $('approvalDeny'),
};

const orb = new window.VerityOrb(el.orb);
orb.start();

// Populated from the main process so the palette is defined in one place.
let personaData = { current: 'verity', language: 'en', personas: [] };
let assistantName = 'Verity';

let config = null;
let history = [];
let busy = false;

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const LABELS = {
  idle: 'Ready',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  error: 'Error',
};

function setState(state, label) {
  orb.setState(state);
  el.stateLabel.textContent = label || LABELS[state] || '';
  el.stateLabel.dataset.state = state;
  // Without audio behind it, the orb should fall back to its synthetic motion.
  if (state !== 'listening' && state !== 'speaking') {
    orb.setSpectrum(null);
    orb.setLevel(0);
  }
}

/* ------------------------------------------------------------------ */
/* Transcript rendering                                                */
/* ------------------------------------------------------------------ */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function renderMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}

function scrollDown() {
  el.messages.scrollTop = el.messages.scrollHeight;
}

function clearEmptyState() {
  // The centred layout only applies while there is nothing to read.
  el.messages.classList.remove('is-empty');
  const empty = el.messages.querySelector('.empty');
  if (empty) empty.remove();
}

function addMessage(role, text) {
  clearEmptyState();
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const label = document.createElement('div');
  label.className = 'msg-role';
  label.textContent = role === 'user' ? 'You' : role === 'error' ? 'Problem' : assistantName;
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.innerHTML = renderMarkdown(text || '');
  wrap.append(label, body);
  el.messages.append(wrap);
  scrollDown();
  return body;
}

function addTrace(id, summary) {
  clearEmptyState();
  const row = document.createElement('div');
  row.className = 'trace running';
  row.dataset.traceId = id;
  row.innerHTML = '<span class="spark"></span><span class="trace-text"></span>';
  row.querySelector('.trace-text').textContent = summary;
  el.messages.append(row);
  scrollDown();
}

function finishTrace(id, summary, output) {
  const row = el.messages.querySelector(`[data-trace-id="${id}"]`);
  if (!row) return;
  row.classList.remove('running');
  const text = row.querySelector('.trace-text');
  if (output && output.error) {
    const declined = /declined permission/i.test(output.error);
    row.classList.add(declined ? 'denied' : 'failed');
    text.textContent = declined ? `${summary} — declined` : `${summary} — ${output.error}`;
  } else if (output && output.count !== undefined) {
    text.textContent = `${summary} — ${output.count} result${output.count === 1 ? '' : 's'}`;
  } else if (output && output.path) {
    text.textContent = `${summary} — ${output.action || 'saved'} ${output.path}`;
  } else {
    text.textContent = `${summary} — done`;
  }
}

/* ------------------------------------------------------------------ */
/* Microphone and voice-activity detection                             */
/* ------------------------------------------------------------------ */

/**
 * Tuning. The frame is one ScriptProcessor block, about 85 ms at 48 kHz.
 * These are the numbers that decide whether it feels responsive or trigger-happy.
 */
const VAD = {
  START_FRAMES: 2,       // consecutive loud frames before we call it speech
  SILENCE_MS: 850,       // quiet for this long ends the utterance
  MIN_SPEECH_MS: 320,    // shorter than this is a cough or a door
  MAX_UTTERANCE_MS: 25000,
  PREROLL_FRAMES: 5,     // ~400 ms kept back so the first word is never clipped
  FLOOR_MULTIPLE: 2.9,   // speech must exceed the noise floor by this much
  MIN_THRESHOLD: 0.011,  // absolute floor for a silent room
};

let mic = null;          // { stream, ctx, source, processor, analyser, sink }
let listening = false;   // hands-free mode is armed
let micPaused = false;   // ignore input while thinking or speaking
let capturing = false;   // an utterance is in progress
const preroll = [];
let chunks = [];
let loudFrames = 0;
let silenceMs = 0;
let speechMs = 0;
let noiseFloor = 0.006;
let freqData = null;

function floatToInt16(input) {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Box-average down to the 16 kHz whisper expects. */
function downsample(frames, inputRate) {
  const total = frames.reduce((n, c) => n + c.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const c of frames) {
    merged.set(c, offset);
    offset += c.length;
  }
  if (inputRate === 16000) return floatToInt16(merged);

  const ratio = inputRate / 16000;
  const outLength = Math.floor(merged.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(merged.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let n = 0;
    for (let j = start; j < end; j++) {
      sum += merged[j];
      n++;
    }
    out[i] = n ? sum / n : 0;
  }
  return floatToInt16(out);
}

async function openMic() {
  if (mic) return true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    setState('error', 'Microphone blocked');
    addMessage(
      'error',
      'Verity could not open the microphone. Open System Settings › Privacy & Security › Microphone and switch Verity on, then try again.'
    );
    setTimeout(() => setState('idle'), 3000);
    return false;
  }

  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.72;
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  // The processor only runs while connected to a destination, but routing the
  // microphone to the speakers would howl — so the sink is silent.
  const sink = ctx.createGain();
  sink.gain.value = 0;

  freqData = new Uint8Array(analyser.frequencyBinCount);
  const frameMs = (4096 / ctx.sampleRate) * 1000;

  processor.onaudioprocess = (e) => {
    const data = e.inputBuffer.getChannelData(0);

    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);

    if (!micPaused) {
      analyser.getByteFrequencyData(freqData);
      orb.setSpectrum(freqData);
      orb.setLevel(Math.min(1, rms * 7));
    }

    if (!listening || micPaused) return;

    const threshold = Math.max(noiseFloor * VAD.FLOOR_MULTIPLE, VAD.MIN_THRESHOLD);
    const frame = new Float32Array(data);

    if (!capturing) {
      // Keep a rolling pre-roll so the utterance does not start mid-word.
      preroll.push(frame);
      if (preroll.length > VAD.PREROLL_FRAMES) preroll.shift();

      if (rms < threshold) {
        // Track the room's quiet level, but only while nobody is talking.
        noiseFloor = noiseFloor * 0.94 + rms * 0.06;
        loudFrames = 0;
      } else if (++loudFrames >= VAD.START_FRAMES) {
        capturing = true;
        chunks = preroll.slice();
        preroll.length = 0;
        silenceMs = 0;
        speechMs = 0;
        setState('listening', 'Listening…');
      }
      return;
    }

    chunks.push(frame);
    speechMs += frameMs;
    silenceMs = rms < threshold ? silenceMs + frameMs : 0;

    if (silenceMs >= VAD.SILENCE_MS || speechMs >= VAD.MAX_UTTERANCE_MS) {
      const spoken = speechMs - silenceMs;
      const captured = chunks;
      capturing = false;
      chunks = [];
      loudFrames = 0;

      if (spoken < VAD.MIN_SPEECH_MS) {
        setState('listening', 'Listening');
        return;
      }
      handleUtterance(captured, ctx.sampleRate);
    }
  };

  source.connect(analyser);
  source.connect(processor);
  processor.connect(sink);
  sink.connect(ctx.destination);

  mic = { stream, ctx, source, processor, analyser, sink };
  return true;
}

function closeMic() {
  if (!mic) return;
  try {
    mic.processor.onaudioprocess = null;
    mic.processor.disconnect();
    mic.source.disconnect();
    mic.analyser.disconnect();
    mic.sink.disconnect();
  } catch {
    /* already torn down */
  }
  mic.stream.getTracks().forEach((t) => t.stop());
  mic.ctx.close();
  mic = null;
  capturing = false;
  chunks = [];
  preroll.length = 0;
  orb.setSpectrum(null);
}

/** True while a wake word has been heard and Verity is expecting the request. */
let awake = false;
let awakeTimer = null;

function wakeEnabled() {
  return Boolean(config?.wakeWord?.enabled);
}

function setAwake(value) {
  awake = value;
  clearTimeout(awakeTimer);
  if (value) {
    // Do not stay armed indefinitely: without this, something said minutes later
    // across the room becomes a command.
    awakeTimer = setTimeout(() => {
      awake = false;
      if (listening) setState('listening', `Say “${config.wakeWord.phrase}”`);
    }, 12000);
  }
}

function listeningLabel() {
  if (wakeEnabled() && !awake) return `Say “${config.wakeWord.phrase}”`;
  return 'Listening';
}

async function handleUtterance(frames, sampleRate) {
  micPaused = true;
  // While waiting on the wake word this happens constantly, so it stays quiet
  // rather than flashing "Transcribing" at every passing noise.
  const gating = wakeEnabled() && !awake;
  setState(gating ? 'listening' : 'thinking', gating ? listeningLabel() : 'Transcribing');

  const pcm = downsample(frames, sampleRate);
  const result = await window.verity.speech.transcribe(pcm.buffer, 16000);

  if (!result.ok) {
    addMessage('error', result.error);
    setState('error');
    setTimeout(resumeListening, 2200);
    return;
  }

  const text = (result.text || '').trim();
  if (text.length < 2) {
    resumeListening(gating ? undefined : "Didn't catch that");
    return;
  }

  if (gating) {
    const phrase = String(config.wakeWord.phrase || 'verity').toLowerCase();
    const lower = text.toLowerCase();
    const at = lower.indexOf(phrase);
    if (at === -1) {
      // Not for us. Say nothing and keep waiting — no transcript, no trace.
      resumeListening();
      return;
    }

    // "Verity, what's the weather" carries its request with it; "Verity" alone
    // is just an address, so wait for what comes next.
    const rest = text.slice(at + phrase.length).replace(/^[\s,.:;!?—-]+/, '').trim();
    if (rest.length >= 3) {
      await submit(rest, { spoken: true });
      setAwake(false);
      resumeListening();
      return;
    }

    setAwake(true);
    resumeListening('Yes?');
    return;
  }

  await submit(text, { spoken: true });
  // Each request needs the wake word again, so a room conversation afterwards
  // is not taken as more instructions.
  setAwake(false);
  resumeListening();
}

function resumeListening(note) {
  micPaused = false;
  capturing = false;
  chunks = [];
  preroll.length = 0;
  loudFrames = 0;
  silenceMs = 0;
  if (listening) setState('listening', note || listeningLabel());
  else setState('idle', note);
}

async function startListening() {
  if (listening) return;
  if (!(await openMic())) return;
  listening = true;
  micPaused = false;
  setAwake(false);
  el.mic.classList.add('recording');
  el.mic.title = 'Stop listening';
  setState('listening', listeningLabel());
}

function stopListening() {
  listening = false;
  micPaused = false;
  el.mic.classList.remove('recording');
  el.mic.title = 'Start listening';
  closeMic();
  setState('idle');
}

function toggleListening() {
  if (listening) stopListening();
  else startListening();
}

/* ------------------------------------------------------------------ */
/* Playback                                                            */
/* ------------------------------------------------------------------ */

let outCtx = null;
let currentSource = null;

async function outputContext() {
  if (outCtx && outCtx.state !== 'closed') {
    if (outCtx.state === 'suspended') await outCtx.resume();
    return outCtx;
  }
  outCtx = new AudioContext();
  const deviceId = el.outputDevice.value;
  // Route to the chosen device — the Mac's own speakers by default — without
  // touching the system-wide output setting.
  if (deviceId && deviceId !== 'default' && typeof outCtx.setSinkId === 'function') {
    try {
      await outCtx.setSinkId(deviceId);
    } catch {
      /* fall back to the system default */
    }
  }
  return outCtx;
}

function stopSpeaking() {
  if (currentSource) {
    try {
      currentSource.stop();
    } catch {
      /* already finished */
    }
    currentSource = null;
  }
}

async function speak(text) {
  if (!text || !el.autoSpeak.checked) return;
  const res = await window.verity.speech.speak(text, config.voice.name, Number(el.rate.value));
  if (!res.ok) {
    addMessage('error', res.error);
    return;
  }
  if (res.empty || !res.audio) return;

  const ctx = await outputContext();
  let buffer;
  try {
    buffer = await ctx.decodeAudioData(res.audio);
  } catch {
    return;
  }

  await new Promise((resolve) => {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.7;
    source.connect(analyser);
    analyser.connect(ctx.destination);

    const spectrum = new Uint8Array(analyser.frequencyBinCount);
    const wave = new Uint8Array(analyser.fftSize);
    let animating = true;

    const tick = () => {
      if (!animating) return;
      analyser.getByteFrequencyData(spectrum);
      analyser.getByteTimeDomainData(wave);
      let sum = 0;
      for (let i = 0; i < wave.length; i++) {
        const v = (wave[i] - 128) / 128;
        sum += v * v;
      }
      orb.setSpectrum(spectrum);
      orb.setLevel(Math.min(1, Math.sqrt(sum / wave.length) * 3.4));
      requestAnimationFrame(tick);
    };

    source.onended = () => {
      animating = false;
      orb.setSpectrum(null);
      orb.setLevel(0);
      currentSource = null;
      resolve();
    };

    currentSource = source;
    setState('speaking');
    source.start();
    tick();
  });
}

/* ------------------------------------------------------------------ */
/* Conversation                                                        */
/* ------------------------------------------------------------------ */

async function submit(text, { spoken = false } = {}) {
  const message = String(text || '').trim();
  if (!message || busy) return;

  busy = true;
  micPaused = true; // never listen to ourselves
  stopSpeaking();
  el.send.classList.add('hidden');
  el.stop.classList.remove('hidden');
  el.input.value = '';
  autosize();

  addMessage('user', message);
  setState('thinking');

  const body = addMessage('assistant', '');
  const cursor = document.createElement('span');
  cursor.className = 'cursor';
  body.append(cursor);

  let streamed = '';
  const offToken = window.verity.chat.onToken((token) => {
    streamed += token;
    body.innerHTML = renderMarkdown(streamed);
    body.append(cursor);
    scrollDown();
  });

  const result = await window.verity.chat.send({ message, history, spoken });

  offToken();
  cursor.remove();

  if (!result.ok) {
    body.parentElement.remove();
    if (!result.aborted) {
      addMessage('error', result.error || 'Something went wrong.');
      setState('error');
    } else {
      setState('idle');
    }
  } else {
    const final = result.text || streamed;
    body.innerHTML = renderMarkdown(final);
    history.push({ role: 'user', content: message });
    history.push({ role: 'assistant', content: final });
    // Keep the window small — context is the scarce resource on 8GB.
    if (history.length > 20) history = history.slice(-20);
    if (final) await speak(final);
  }

  busy = false;
  el.stop.classList.add('hidden');
  el.send.classList.remove('hidden');
  if (!listening) {
    setState('idle');
    el.input.focus();
  }
}

/* ------------------------------------------------------------------ */
/* Tool approval                                                       */
/* ------------------------------------------------------------------ */

let pendingApproval = null;

window.verity.tools.onApprovalRequest(({ id, name, input, summary }) => {
  pendingApproval = { id, name };
  el.approvalTitle.textContent = summary;
  el.approvalArgs.textContent = JSON.stringify(input || {}, null, 2);
  el.approvalRemember.checked = false;
  el.approval.classList.remove('hidden');
});

function respondToApproval(approved) {
  if (!pendingApproval) return;
  window.verity.tools.respond({
    id: pendingApproval.id,
    approved,
    remember: el.approvalRemember.checked ? pendingApproval.name : null,
  });
  if (el.approvalRemember.checked && approved) loadPermissions();
  pendingApproval = null;
  el.approval.classList.add('hidden');
}

el.approvalAllow.addEventListener('click', () => respondToApproval(true));
el.approvalDeny.addEventListener('click', () => respondToApproval(false));

// The scheduled brief arrives unprompted, so it reads itself out.
window.verity.brief.onReady(async ({ text }) => {
  addMessage('assistant', text);
  await speak(text);
  setState(listening ? 'listening' : 'idle', listening ? listeningLabel() : undefined);
});

// A finished timer announces itself, since you may well be in another app.
window.verity.timers.onElapsed(async ({ label }) => {
  addMessage('assistant', `${label} — time is up.`);
  await speak(`${label}. Time is up.`);
  setState(listening ? 'listening' : 'idle');
});

window.verity.chat.onToolStart(({ id, summary }) => addTrace(id, summary));
window.verity.chat.onToolEnd(({ id, summary, output }) => finishTrace(id, summary, output));

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

function pill(label, on, title) {
  const span = document.createElement('span');
  span.className = `pill ${on ? 'on' : 'off'}`;
  span.title = title || '';
  span.innerHTML = '<span class="dot"></span>';
  span.append(document.createTextNode(label));
  return span;
}

async function refreshStatus() {
  const s = await window.verity.status.all();
  el.statusbar.replaceChildren(
    pill(s.ollama ? 'Ollama' : 'Ollama off', s.ollama, s.ollama ? 'Local models available' : 'Run: ollama serve'),
    pill(
      s.wikipedia.available ? 'Wikipedia' : 'No archive',
      s.wikipedia.available,
      s.wikipedia.available ? s.wikipedia.active : 'Plug in the USB drive holding your .zim file'
    ),
    pill(
      s.obsidian.available ? `${s.obsidian.notes} notes` : 'No vault',
      s.obsidian.available,
      s.obsidian.available ? s.obsidian.path : s.obsidian.error
    ),
    (() => {
      // Default the language rather than interpolating it raw: a missing value
      // rendered as the literal "Voice in (undefined)".
      const lang = s.language || 'en';
      return pill(
        s.whisper ? `Voice in${lang !== 'en' ? ` (${lang})` : ''}` : 'No speech model',
        s.whisper,
        s.whisper
          ? `whisper.cpp ready, listening in ${lang}`
          : `No speech model for ${lang} — ggml-base.bin is needed for anything but English`
      );
    })(),
    pill(s.online ? 'Online' : 'Offline', s.online, s.online ? 'Live lookups available' : 'Live lookups unavailable')
  );
  renderZimStatus(s.wikipedia);
}

function renderZimStatus(wiki) {
  if (wiki.available) {
    const info = wiki.info || {};
    el.zimStatus.innerHTML = `
      <p><strong>${escapeHtml(info.title || 'Archive')}</strong> is connected.</p>
      <p>${Number(info.entryCount || 0).toLocaleString()} entries${info.date ? `, dated ${escapeHtml(info.date)}` : ''}.</p>
      <p><code>${escapeHtml(wiki.active)}</code></p>`;
  } else {
    el.zimStatus.innerHTML = `
      <p>No <code>.zim</code> archive found.</p>
      <p>Copy one onto a USB drive and plug it in — Verity scans <code>/Volumes</code> automatically.
      See <code>WIKIPEDIA.md</code> for which archive to download.</p>`;
  }
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

async function loadModels() {
  const data = await window.verity.models.list();
  const list = config.provider === 'claude' ? data.claude : data.ollama;
  el.model.replaceChildren();

  if (!list.length) {
    const opt = document.createElement('option');
    opt.textContent = config.provider === 'claude' ? 'Add an API key first' : 'No models installed';
    opt.value = '';
    el.model.append(opt);
    el.modelHint.textContent =
      config.provider === 'claude'
        ? 'Save a Claude API key below to use hosted models.'
        : data.error || 'Install one with: ollama pull qwen2.5:1.5b';
    return;
  }

  for (const m of list) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.bytes ? `${m.label} (${(m.bytes / 1e9).toFixed(1)} GB)` : m.label;
    el.model.append(opt);
  }

  const current = config.provider === 'claude' ? config.claudeModel : config.model;
  if (list.some((m) => m.id === current)) el.model.value = current;
  else el.model.selectedIndex = 0;

  el.modelHint.textContent =
    config.provider === 'claude'
      ? 'Runs in the cloud. Needs a connection.'
      : 'Runs entirely on this Mac. Nothing leaves the machine.';

  // The voice model is local-only: sending speech to a hosted model would make
  // every spoken reply wait on the network, which defeats the point.
  el.voiceModel.replaceChildren();
  const same = document.createElement('option');
  same.value = '';
  same.textContent = 'Same model as typing';
  el.voiceModel.append(same);
  for (const m of data.ollama) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.bytes ? `${m.label} (${(m.bytes / 1e9).toFixed(1)} GB)` : m.label;
    el.voiceModel.append(opt);
  }
  el.voiceModel.value = data.ollama.some((m) => m.id === config.voiceModel) ? config.voiceModel : '';
}

async function loadVoices() {
  const voices = await window.verity.speech.voices();
  el.voice.replaceChildren();
  for (const v of voices) {
    const opt = document.createElement('option');
    opt.value = v.name;
    opt.textContent = v.novelty ? `${v.name} (novelty)` : `${v.name} — ${v.locale}`;
    el.voice.append(opt);
  }
  if (voices.some((v) => v.name === config.voice.name)) {
    el.voice.value = config.voice.name;
  } else if (voices.length) {
    el.voice.selectedIndex = 0;
    config.voice.name = el.voice.value;
    await window.verity.config.set({ voice: { name: el.voice.value } });
  }
}

async function loadOutputDevices() {
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    /* labels need permission; the default option still works */
  }
  const outputs = devices.filter((d) => d.kind === 'audiooutput');
  el.outputDevice.replaceChildren();

  const sys = document.createElement('option');
  sys.value = 'default';
  sys.textContent = 'System default';
  el.outputDevice.append(sys);

  for (const d of outputs) {
    if (d.deviceId === 'default') continue;
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || 'Output device';
    el.outputDevice.append(opt);
  }

  // Prefer the Mac's own speakers: otherwise macOS sends the reply back into the
  // AirPods you were talking into.
  const builtIn = outputs.find((d) => /macbook|built-?in|internal/i.test(d.label || ''));
  const saved = config.ui.outputDeviceId;
  if (saved && outputs.some((d) => d.deviceId === saved)) el.outputDevice.value = saved;
  else if (builtIn) el.outputDevice.value = builtIn.deviceId;
  else el.outputDevice.value = 'default';
}

/**
 * Apply a persona: name, accent colours and orb palette.
 *
 * Colours are written as CSS custom properties, which the whole stylesheet
 * already reads from, so one assignment retints every control at once.
 */
function applyPersona(id) {
  const persona = personaData.personas.find((p) => p.id === id) || personaData.personas[0];
  if (!persona) return;

  assistantName = persona.name;
  el.brandName.textContent = persona.name;
  document.title = persona.name;

  for (const [property, value] of Object.entries(persona.theme || {})) {
    document.documentElement.style.setProperty(property, value);
  }
  orb.setPalette(persona.orb);

  const speech = (persona.speech && persona.speech[config.language || 'en']) || {};
  const bits = [persona.tagline];
  if (speech.voice) bits.push(`Suggested voice: ${speech.voice}.`);
  if (config.language === 'ja') bits.push('Listening and replying in Japanese.');
  el.personaHint.textContent = bits.filter(Boolean).join(' ');
}

async function loadPersonas() {
  personaData = await window.verity.personas.list();
  el.persona.replaceChildren();
  for (const p of personaData.personas) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    el.persona.append(opt);
  }
  el.persona.value = config.persona || 'verity';
  el.language.value = config.language || 'en';
  applyPersona(el.persona.value);
}

/** Move the voice to the persona's preferred one, unless it is already suitable. */
async function adoptPersonaVoice() {
  const persona = personaData.personas.find((p) => p.id === (config.persona || 'verity'));
  const preferred = persona?.speech?.[config.language || 'en']?.voice;
  if (!preferred) return;
  const available = [...el.voice.options].some((o) => o.value === preferred);
  if (!available || el.voice.value === preferred) return;
  el.voice.value = preferred;
  config = await window.verity.config.set({ voice: { name: preferred } });
}

async function loadPermissions() {
  const tools = await window.verity.tools.list();
  el.permissions.replaceChildren();
  for (const t of tools) {
    const row = document.createElement('div');
    row.className = 'perm';
    const name = document.createElement('span');
    name.className = 'perm-name';
    name.textContent = t.name;
    name.title = t.description;
    const select = document.createElement('select');
    for (const value of ['allow', 'ask', 'deny']) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = value;
      select.append(opt);
    }
    select.value = t.permission;
    select.addEventListener('change', async () => {
      config = await window.verity.config.set({ permissions: { [t.name]: select.value } });
    });
    row.append(name, select);
    el.permissions.append(row);
  }
}

function openSettings(open) {
  el.settings.classList.toggle('open', open);
  el.scrim.classList.toggle('open', open);
  el.settings.setAttribute('aria-hidden', String(!open));
  if (open) {
    loadModels();
    loadOutputDevices();
    refreshStatus();
  }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

function autosize() {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 132)}px`;
}

el.input.addEventListener('input', autosize);
el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit(el.input.value);
  }
});

el.send.addEventListener('click', () => submit(el.input.value));
el.stop.addEventListener('click', () => {
  window.verity.chat.abort();
  stopSpeaking();
});

// One button, one meaning: start or stop listening.
el.mic.addEventListener('click', toggleListening);

// Clicking the orb interrupts a reply you have heard enough of.
el.orb.addEventListener('click', () => {
  if (currentSource) stopSpeaking();
  else toggleListening();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (pendingApproval) respondToApproval(false);
    else if (el.settings.classList.contains('open')) openSettings(false);
    else if (currentSource) stopSpeaking();
    else if (listening) stopListening();
  }
  // Space toggles listening, as long as you are not typing.
  if (e.code === 'Space' && document.activeElement !== el.input && !pendingApproval) {
    e.preventDefault();
    toggleListening();
  }
});

el.newChat.addEventListener('click', () => {
  history = [];
  stopSpeaking();
  // Close the saved conversation so the next turn opens a fresh note.
  window.verity.chat.new();
  el.messages.replaceChildren();
  el.messages.classList.add('is-empty');
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.innerHTML =
    '<p class="empty-lede">New conversation. Everything before this is forgotten — unless you asked me to save it.</p>';
  el.messages.append(empty);
  setState(listening ? 'listening' : 'idle');
});

el.settingsBtn.addEventListener('click', () => openSettings(true));
el.closeSettings.addEventListener('click', () => openSettings(false));
el.scrim.addEventListener('click', () => openSettings(false));

el.persona.addEventListener('change', async () => {
  config = await window.verity.config.set({ persona: el.persona.value });
  applyPersona(el.persona.value);
  await adoptPersonaVoice();
});

el.language.addEventListener('change', async () => {
  config = await window.verity.config.set({ language: el.language.value });
  applyPersona(config.persona || 'verity');
  await adoptPersonaVoice();
  // Switching language changes the speech recognition model, so surface it
  // immediately rather than at the next thing the user says.
  refreshStatus();
});

el.provider.addEventListener('change', async () => {
  config = await window.verity.config.set({ provider: el.provider.value });
  await loadModels();
  const value = el.model.value;
  if (value) {
    config = await window.verity.config.set(
      el.provider.value === 'claude' ? { claudeModel: value } : { model: value }
    );
  }
});

el.model.addEventListener('change', async () => {
  config = await window.verity.config.set(
    el.provider.value === 'claude' ? { claudeModel: el.model.value } : { model: el.model.value }
  );
});

el.voiceModel.addEventListener('change', async () => {
  config = await window.verity.config.set({ voiceModel: el.voiceModel.value });
});

el.keepAlive.addEventListener('change', async () => {
  config = await window.verity.config.set({ ollamaKeepAlive: el.keepAlive.value });
});

el.numCtx.addEventListener('change', async () => {
  config = await window.verity.config.set({ numCtx: Number(el.numCtx.value) });
});

el.voice.addEventListener('change', async () => {
  config = await window.verity.config.set({ voice: { name: el.voice.value } });
});

el.rate.addEventListener('change', async () => {
  config = await window.verity.config.set({ voice: { rate: Number(el.rate.value) } });
});

el.autoSpeak.addEventListener('change', async () => {
  config = await window.verity.config.set({ ui: { autoSpeak: el.autoSpeak.checked } });
});

el.autoListen.addEventListener('change', async () => {
  config = await window.verity.config.set({ ui: { autoListen: el.autoListen.checked } });
});

el.wakeEnabled.addEventListener('change', async () => {
  config = await window.verity.config.set({ wakeWord: { enabled: el.wakeEnabled.checked } });
  setAwake(false);
  if (listening) setState('listening', listeningLabel());
});

el.wakePhrase.addEventListener('change', async () => {
  const phrase = el.wakePhrase.value.trim().toLowerCase();
  if (!phrase) {
    el.wakePhrase.value = config.wakeWord.phrase;
    return;
  }
  config = await window.verity.config.set({ wakeWord: { phrase } });
  if (listening) setState('listening', listeningLabel());
});

el.briefEnabled.addEventListener('change', async () => {
  config = await window.verity.config.set({ brief: { enabled: el.briefEnabled.checked } });
});

el.briefTime.addEventListener('change', async () => {
  const value = el.briefTime.value.trim();
  if (!/^\d{1,2}:\d{2}$/.test(value)) {
    // Reject rather than silently store something the scheduler will never match.
    el.briefTime.value = config.brief.time;
    return;
  }
  config = await window.verity.config.set({ brief: { time: value } });
});

el.homeLocation.addEventListener('change', async () => {
  config = await window.verity.config.set({ homeLocation: el.homeLocation.value.trim() });
});

el.loginItem.addEventListener('change', async () => {
  const enabled = await window.verity.app.setLoginItem(el.loginItem.checked);
  el.loginItem.checked = enabled;
});

el.testBrief.addEventListener('click', async () => {
  el.testBrief.disabled = true;
  el.testBrief.textContent = 'Gathering…';
  const result = await window.verity.brief.run();
  el.testBrief.disabled = false;
  el.testBrief.textContent = 'Read the brief now';
  if (!result.ok) {
    addMessage('error', result.error);
    return;
  }
  openSettings(false);
  addMessage('assistant', result.text);
  await speak(result.text);
  setState(listening ? 'listening' : 'idle', listening ? listeningLabel() : undefined);
});

el.saveConversations.addEventListener('change', async () => {
  config = await window.verity.config.set({ saveConversations: el.saveConversations.checked });
});

el.outputDevice.addEventListener('change', async () => {
  config = await window.verity.config.set({ ui: { outputDeviceId: el.outputDevice.value } });
  if (outCtx) {
    await outCtx.close();
    outCtx = null;
  }
});

el.testVoice.addEventListener('click', async () => {
  const wasAuto = el.autoSpeak.checked;
  el.autoSpeak.checked = true;
  await speak('Verity here. This is how I will sound.');
  el.autoSpeak.checked = wasAuto;
  setState(listening ? 'listening' : 'idle');
});

el.vaultPath.addEventListener('change', async () => {
  config = await window.verity.config.set({ vaultPath: el.vaultPath.value.trim() });
  refreshStatus();
});

el.vaultFolder.addEventListener('change', async () => {
  config = await window.verity.config.set({ vaultFolder: el.vaultFolder.value.trim() });
});

el.revealVault.addEventListener('click', () => window.verity.vault.reveal());

el.saveKey.addEventListener('click', async () => {
  const key = el.claudeKey.value.trim();
  if (!key) return;
  await window.verity.config.setClaudeKey(key);
  el.claudeKey.value = '';
  el.claudeKey.placeholder = 'Saved in Keychain';
  await loadModels();
});

el.clearKey.addEventListener('click', async () => {
  await window.verity.config.setClaudeKey(null);
  el.claudeKey.value = '';
  el.claudeKey.placeholder = 'sk-ant-…';
  if (config.provider === 'claude') {
    config = await window.verity.config.set({ provider: 'ollama' });
    el.provider.value = 'ollama';
  }
  await loadModels();
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  config = await window.verity.config.get();

  el.provider.value = config.provider;
  el.keepAlive.value = config.ollamaKeepAlive;
  el.numCtx.value = String(config.numCtx);
  el.autoSpeak.checked = config.ui.autoSpeak;
  el.autoListen.checked = config.ui.autoListen;
  el.wakeEnabled.checked = config.wakeWord.enabled;
  el.wakePhrase.value = config.wakeWord.phrase;
  el.briefEnabled.checked = config.brief.enabled;
  el.briefTime.value = config.brief.time;
  el.homeLocation.value = config.homeLocation || '';
  el.saveConversations.checked = config.saveConversations !== false;
  window.verity.app.getLoginItem().then((on) => {
    el.loginItem.checked = on;
  });
  el.rate.value = config.voice.rate;
  el.vaultPath.value = config.resolvedVaultPath || config.vaultPath || '';
  el.vaultFolder.value = config.vaultFolder;
  if (config.hasClaudeKey) el.claudeKey.placeholder = 'Saved in Keychain';

  setState('idle');
  await Promise.all([loadModels(), loadVoices(), loadPermissions(), refreshStatus()]);
  await loadPersonas();
  await loadOutputDevices();

  // Volumes get mounted and unmounted while the app is open; keep the pills honest.
  setInterval(refreshStatus, 20000);

  if (config.ui.autoListen) startListening();
  else el.input.focus();
}

boot();
