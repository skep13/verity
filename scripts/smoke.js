// Exercise every part of Verity against the real environment and report what
// actually works. Runs inside Electron so the clipboard, Keychain and app paths
// are the genuine APIs rather than stubs.
//
//   npx electron scripts/smoke.js
//
// Read-only and harmless calls only: nothing here writes to your calendar,
// reminders or vault.
const { app } = require('electron');

// Run under the packaged app's identity. Without this, `npx electron` reports its
// name as "Electron", userData resolves to a different directory, and the smoke
// test silently checks default settings and an empty index rather than the real
// ones — reporting problems that do not exist and hiding ones that do.
app.setName('Verity');

const config = require('../src/main/config');
const tools = require('../src/main/tools');
const obsidian = require('../src/main/tools/obsidian');
const wikipedia = require('../src/main/tools/wikipedia');
const vault = require('../src/main/vault');
const stt = require('../src/main/speech/stt');
const tts = require('../src/main/speech/tts');
const ollama = require('../src/main/providers/ollama');
const agent = require('../src/main/agent');

const pad = (s, n) => String(s).padEnd(n);
let failures = 0;

function report(name, ok, detail) {
  const mark = ok === true ? 'ok  ' : ok === null ? 'n/a ' : 'FAIL';
  if (ok === false) failures++;
  console.log(`  ${mark} ${pad(name, 22)} ${detail || ''}`);
}

async function tryTool(name, input) {
  try {
    const out = await tools.execute(name, input, { requestApproval: async () => true });
    // Check availability before error: an unplugged drive or no connection sets
    // both, and reporting that as a failure is misleading.
    if (out && out.available === false) return report(name, null, (out.error || '').slice(0, 80));
    if (out && out.error) return report(name, false, out.error.slice(0, 80));
    const summary = JSON.stringify(out).replace(/\s+/g, ' ').slice(0, 78);
    report(name, true, summary);
  } catch (err) {
    report(name, false, err.message.slice(0, 80));
  }
}

app.whenReady().then(async () => {
  console.log('\n── environment ──');
  const running = await ollama.isRunning();
  report('ollama', running, running ? `${config.load().ollamaHost}` : 'not running — ollama serve');
  if (running) {
    const models = await ollama.listModels();
    report('models installed', models.length > 0, models.map((m) => m.id).join(', ').slice(0, 78));
  }
  report('speech model', stt.available(), stt.modelPath() || 'missing ggml-base.en.bin');
  const voices = await tts.listVoices();
  report('voices', voices.length > 0, `${voices.length} available, using ${config.load().voice.name}`);
  const embeds = await vault.isAvailable();
  report('embeddings', embeds, embeds ? vault.EMBED_MODEL : `missing — ollama pull ${vault.EMBED_MODEL}`);

  console.log('\n── data sources ──');
  const vaultStatus = obsidian.status();
  report('vault', vaultStatus.available, vaultStatus.available ? `${vaultStatus.notes} notes at ${vaultStatus.path}` : vaultStatus.error);
  const profile = obsidian.readProfile();
  report('profile', Boolean(profile), profile ? `${profile.length} chars, in every prompt` : 'not created');
  const idx = vault.stats();
  report('semantic index', idx.files > 0, `${idx.files} files, ${idx.passages} passages`);
  const wiki = wikipedia.status();
  // Absent by circumstance, not broken — the drive simply is not plugged in.
  report('offline wikipedia', wiki.available || null, wiki.available ? wiki.active : 'no .zim found — plug in the drive');

  console.log('\n── tools ──');
  await tryTool('datetime', {});
  await tryTool('calendar_list', { days: 1 });
  await tryTool('reminders_list', { limit: 3 });
  await tryTool('clipboard_read', {});
  await tryTool('files_search', { query: 'Verity', limit: 2 });
  await tryTool('obsidian_search', { query: 'profile', limit: 2 });
  await tryTool('obsidian_list', {});
  await tryTool('wikipedia_search', { query: 'Photosynthesis' });
  await tryTool('weather', {});
  await tryTool('web_search', { query: 'bbc news', limit: 2 });
  await tryTool('web_fetch', { url: 'https://example.com' });
  await tryTool('timer_set', { minutes: 1, label: 'smoke test' });
  await tryTool('timer_list', {});
  await tryTool('timer_cancel', { id: 1 });

  console.log('\n── end to end ──');
  if (running) {
    const started = Date.now();
    try {
      const result = await agent.run({
        history: [],
        userMessage: 'In one short sentence, what is the capital of France?',
        spoken: false,
        requestApproval: async () => true,
      });
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      report('model reply', Boolean(result.text), `${seconds}s — ${result.text.slice(0, 60)}`);
    } catch (err) {
      report('model reply', false, err.message.slice(0, 80));
    }
  }

  console.log(`\n${failures === 0 ? 'No failures.' : `${failures} failure(s).`}`);
  console.log('"n/a" means unavailable by circumstance — offline, or a drive unplugged — not broken.\n');
  wikipedia.closeAll();
  app.exit(failures === 0 ? 0 : 1);
});
