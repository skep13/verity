# Verity

A private desktop assistant that runs on your own Mac. It speaks, it listens, it
remembers things in your Obsidian vault, and it can read an offline copy of
Wikipedia from a USB stick. Nothing is sent anywhere unless you deliberately add
a Claude API key and select it.

Built for a MacBook Air M2 with 8 GB of RAM, which is the constraint behind most
of the decisions below.

Apple silicon only. Two dev dependencies, no native modules, nothing to compile.

## Installing

```bash
# 1. Prerequisites
brew install ollama whisper-cpp
brew services start ollama          # so models are always available

# 2. Models — a chat model and the embedding model for vault search
ollama pull qwen2.5:3b
ollama pull nomic-embed-text

# 3. Speech recognition models (not in the repo; ~290 MB together)
mkdir -p models
curl -L -o models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
# Only needed for languages other than English:
curl -L -o models/ggml-base.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin

# 4. Build
npm install
npm run build
cp -R dist/mac-arm64/Verity.app /Applications/
```

The build is unsigned, so macOS ties microphone permission to an ad-hoc
signature. `npm run build` applies one automatically; without it you would be
re-granting microphone access after every rebuild.

Press **⌘⇧V** from anywhere to summon or hide the window. Verity tells you in the
status bar if Ollama is not running.

```bash
npm run smoke   # check every part against your machine and report what works
```

## What it can do

Ask it anything and it answers from its own knowledge — that works with no vault,
no USB stick and no internet. The tools extend it rather than gate it:

- **Calendar** — reads your schedule and adds events. "What's on tomorrow?",
  "Put dentist in at 3 on Thursday." It checks the calendar before proposing a
  time, so it will not suggest a slot you are already busy for.
- **Reminders** — adds to the Reminders app. It prefers a reminder for a task and
  a calendar event for an appointment.
- **Timers** — "set a timer for 20 minutes." Alerts with a notification and says
  so out loud, so it reaches you in another app. Only lasts while Verity is open.
- **Obsidian** — its long-term memory. "Remember my thesis is due on the 12th"
  writes a note; asking about it later searches the vault first. Notes go into a
  `Verity/` subfolder, so they never mix with your own.
- **Files** — Spotlight search for the document you cannot place, and opening
  files, apps or links.
- **The clipboard** — "what does this mean" about whatever you just copied, and
  copying answers back out. Reading it always asks first: a clipboard holds
  passwords and card numbers seconds after they are copied.
- **Conversation memory** — every exchange is saved to a dated note in `chats/`
  and indexed, so "what did we decide about the thesis last week" is answerable.
  Closing Verity no longer loses everything.
- **The web** — search and read pages, for anything recent: news, this year's
  events, current prices. The offline archive is a fixed snapshot and the model
  has a training cutoff, so this is the only thing that knows about today.
- **Offline Wikipedia** — verifiable facts from a Kiwix archive on a USB drive.
  See [WIKIPEDIA.md](WIKIPEDIA.md) for which archive to download and how.
- **Weather** — live conditions for any place. Needs an internet connection,
  because a forecast is a fact about right now.
- **Date and time** — which it consults before working out what "tomorrow" means,
  rather than guessing.

The first time Verity touches Calendar or Reminders, macOS asks whether to allow
it. If you decline, it will say so plainly instead of failing silently — you can
change your mind in System Settings › Privacy & Security › Automation.

When the USB drive is unplugged or the Mac is offline, Verity carries on
answering normally and tells you only what it could not verify.

## Voice

Press the microphone button or hit **Space**, then just talk. There is nothing to
hold down: Verity listens continuously and works out for itself when you have
started and stopped speaking. It waits for about 850 ms of silence before
deciding you are finished, keeps 400 ms of audio from before you started so the
first word is never clipped, and ignores anything under a third of a second so a
cough does not become a question.

After it answers it goes straight back to listening, so you can carry on talking.
Press Space or Escape to stop, and click the orb to cut a reply short.

The microphone is muted while Verity is thinking and speaking, so it never hears
itself and answers its own voice.

Speech recognition is [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
running locally; the `base.en` model is bundled inside the app. Speech output uses
the macOS speech engine, so every voice already installed on your Mac is
available in Settings.

**AirPods:** when you talk into AirPods, macOS normally sends the reply back to
them too. Verity defaults its output to the MacBook's own speakers so answers come
out of the laptop regardless. Change this under Settings › Voice › Play through.

For a better voice, download a premium one in System Settings › Accessibility ›
Spoken Content › System Voice › Manage Voices. Anything you install shows up in
Verity's list.

The orb is driven by the actual audio — your microphone level while listening,
Verity's own waveform while speaking.

## Loading the vault

With a 3B model, answer quality is decided less by the model than by what is in
front of it. The vault is how you put things there.

### The profile — do this first

```bash
node scripts/vault.js profile
```

Creates `Verity/Profile.md`. Whatever you write there is loaded into **every**
message, so Verity never has to decide to go and look it up — which is the thing
small models are worst at. Who you are, what you are working on, people who come
up, how you want it to answer, deadlines it must never get wrong.

Keep it to about a page. It is paid for out of the context window every time.

### Import documents you already have

```bash
node scripts/vault.js import ~/Documents ~/Desktop/some-folder
```

Word, RTF, ODT, HTML and text convert through macOS's own `textutil`, so there is
nothing to install. PDFs need `brew install poppler`; without it they are skipped
with a reason rather than silently dropped. Each note records the file it came
from, so Verity can say where a fact originated and you can open the real
document.

### Have Verity research topics

```bash
node scripts/research.js "Photosynthesis" "Antikythera mechanism"
node scripts/research.js --file topics.txt --web
```

Reads each subject from the offline archive (and the web with `--web`), then
writes a sourced note into `Reference/`. Notes are written from retrieved text
rather than the model's memory, and cite where each came from. Feed it a long
list and leave it running.

### How search works

Notes are split into passages and embedded with `nomic-embed-text` through
Ollama — entirely local, no key, nothing leaves the Mac. Search finds notes by
meaning, so "when is my dissertation due" finds a note that says "thesis
deadline", which keyword search never would.

The index updates itself: after Verity saves a note, and again on launch to catch
anything you edited in Obsidian meanwhile. Only changed files are re-embedded, so
it normally costs nothing. If Ollama is down or the model is missing, search
quietly falls back to keyword matching rather than failing.

```bash
node scripts/vault.js status     # notes, profile size, index size
node scripts/vault.js index      # force a rebuild
node scripts/vault.js search "…" # try a query, see what it would retrieve
```

`search` is worth using when an answer looks wrong — it shows you exactly what
Verity retrieved, which is usually where the problem is.

## The morning brief

Settings › Morning brief. At the time you set, Verity gathers your calendar,
outstanding reminders and the weather, and reads a few sentences aloud. Set
**Your location** there — it is also what "what's the weather" uses, so you stop
having to name a place every time.

It only fires while Verity is running, hence the **Start Verity at login**
option. A background daemon that launched the app would be a bigger imposition
than the feature is worth. Use **Read the brief now** to hear it without waiting
until morning.

If the model is unreachable it reads the facts out plainly rather than staying
silent, and it will not fire twice in a day.

## Wake word

Settings › Voice › **Wait for a wake word**. With it on, Verity ignores
everything until it hears its name, then takes what follows as the request.
"Verity, what's on today" works in one breath; saying just "Verity" makes it wait
for the next thing you say, and it stops waiting after twelve seconds so a
conversation across the room is not taken as instructions.

This is cheap because the voice detector gates it: audio is only transcribed when
the microphone actually hears a voice, so a quiet room costs nothing. Nothing
that fails to match is kept, logged, or shown.

Each request needs the wake word again. That is deliberate — it stops the
sentence you say to someone else immediately afterwards becoming a command.

## Linked notes

When Verity writes a note it looks for the notes most related to it and appends
Obsidian `[[wikilinks]]`. Relations come from the semantic index, not shared
words, so they are real connections: a note about supervision meetings links to
the thesis deadline, and a note about sourdough links to neither.

The vault becomes a graph you can navigate in Obsidian itself, and retrieval
gains a second route to a note.

## Models

The picker lists whatever `ollama list` reports, so pulling a model makes it
available with no configuration.

These were measured on this machine, on the two tasks that actually separate
them. **Research** is "look up X on Wikipedia, then save a note about it" — it
scores whether the model chained to the second tool instead of claiming it had.
**Calendar** is the plain question "what's on my calendar for today?" — it scores
whether the model called the tool instead of replying that it has no access.

| Model | Disk | RAM while loaded | Reply | Research | Calendar |
|---|---|---|---|---|---|
| `qwen2.5:3b` | 1.9 GB | 2.3 GB | 8 s | 3/3 | **5/5** |
| `qwen2.5:1.5b` | 986 MB | 1.3 GB | 3 s | 3/3 | **2/5** |
| `llama3.2:3b` | 2.0 GB | 2.6 GB | 11 s | 1/3 | — |
| `llama3.2:1b` | 1.3 GB | 1.6 GB | 5 s | 0/3 | — |
| `qwen3:4b` | 2.5 GB | 3.4 GB | 328 s | — | — |

**`qwen2.5:3b` is the default.** `qwen2.5:1.5b` held its own while there were only
eight tools, but once the desk-assistant tools took the count to sixteen it began
picking the wrong one — or none, answering "I don't have access to your calendar"
about a calendar it was holding a tool for. Falsely denying a capability it has is
worse than taking a few more seconds, so the extra gigabyte is worth paying.

`qwen2.5:1.5b` is still a reasonable choice if memory is tight and you mostly want
conversation and Wikipedia rather than calendar and reminders.

`llama3.2:1b` never used a tool in any trial: it answers from memory alone and can
save nothing.

Avoid reasoning models (`qwen3`, `deepseek-r1`). On Ollama they write their chain
of thought into the reply itself and it cannot be suppressed — `qwen3:4b` took
**328 seconds** on the question the default answers in 12, and narrated its own
deliberations, which is unbearable read aloud.

### Keeping RAM free for your browser

Two settings under Model control how much memory Verity leaves you:

- **Keep in RAM for** — how long Ollama holds the model after a reply. Default is
  2 minutes; Ollama's own default is 5, which pins a couple of gigabytes while
  you are back in Chrome. Set it to "Unload immediately" to get the memory back
  the moment Verity finishes, at the cost of a few seconds reloading next time.
- **Context size** — sets the KV cache, which grows linearly with it. 4k is the
  leanest and is plenty for voice questions; 16k only helps in long chats.

With `qwen2.5:1.5b` at 4k context and a 30-second keep-alive, Verity idles at
roughly the cost of the app alone (~350 MB) and peaks near 1.6 GB while thinking.

### Claude

Optional. Paste a key into Settings and hosted models appear in the picker. The
key is encrypted through the macOS Keychain and never written anywhere readable.
Selecting a Claude model means those conversations go to Anthropic; local models
remain entirely offline.

## Tool permissions

Every tool is one of:

- **allow** — runs silently
- **ask** — prompts each time, showing the exact arguments
- **deny** — the tool is never described to the model, so it cannot try

Writing to your vault defaults to **ask**. Tick "always allow" in the prompt to
promote it to allow. Tool activity appears in the transcript as a quiet trace
line, so you can always see what it actually did.

**`web_search` and `web_fetch` also default to ask**, deliberately. Everything
else in Verity stays on this Mac; these two are the only tools that send anything
off it, and your search terms go to DuckDuckGo. That should be a decision you
make rather than one made for you. Set them to allow if you would rather not be
asked each time.

### What the web tools will not do

- **They will not reach your own machine or network.** Every hostname is resolved
  and refused if it lands on loopback, a private range, or link-local — including
  `169.254.169.254`, the usual target of this kind of attack. Redirects are
  followed by hand so each hop is checked, not just the address you started with.
- **They treat page text as data, never instructions.** A page telling Verity to
  ignore its rules or hand over your notes is an attacker writing on a web page,
  not you speaking. Fetched content is labelled untrusted and Verity is told to
  report such attempts rather than act on them.

Two real limits: pages that render entirely in JavaScript come back empty, and
PDFs are not read. Search scrapes DuckDuckGo's lite endpoint rather than using a
paid API, so if they change their markup search will break — it will say so
rather than quietly returning nothing.

## How it is built

```
src/main/         privileged: models, filesystem, tools, speech
  zim/reader.js   Kiwix ZIM parser, pure JS
  providers/      ollama.js, claude.js — interchangeable
  tools/          obsidian, wikipedia, weather + permission gate
  agent.js        the prompt -> tools -> answer loop
src/preload/      the only bridge to the renderer
src/renderer/     UI, orb animation, audio capture and playback
```

Two dev dependencies, no native modules. The ZIM reader is hand-written against
the format spec because Node 22 ships zstd in core, which removes the only reason
to bind to libzim — so there is nothing to compile and nothing to break on an OS
upgrade.

The renderer has no Node access; it talks to a fixed list of named channels in
`src/preload/index.js`.

## Development

```bash
npm start                # run from source
npm test                 # unit tests
npm run smoke            # check every part against this machine
npm run build            # rebuild Verity.app into dist/
npm run check-wikipedia  # verify a .zim archive is readable
npm run preview-orb      # render the orb's states to /tmp
```

Some ZIM reader tests need a sample archive and skip cleanly without one. To run
them, fetch the 15 MB hundred-article sample:

```bash
curl -L -o models/test.zim https://download.kiwix.org/zim/wikipedia/wikipedia_en_100_nopic_2026-07.zim
```

`npx electron scripts/preview-ui.js` renders the real interface headlessly and
writes screenshots to `/tmp`, which is the quickest way to iterate on layout.
`PERSONA=miku` and `LANGUAGE=ja` change what it renders.

`npm start -- --dev` echoes renderer console output to the terminal.

After rebuilding, reinstall with:

```bash
rm -rf /Applications/Verity.app && cp -R dist/mac-arm64/Verity.app /Applications/
```

## Better Japanese speech: VOICEVOX

The macOS voices are serviceable in English and poor in Japanese.
[VOICEVOX](https://voicevox.hiroshiba.jp/) is a free Japanese speech engine that
runs entirely locally and exposes an HTTP API — no account, no network, which is
why it suits this project.

Download the engine for your architecture from the
[releases page](https://github.com/VOICEVOX/voicevox_engine/releases) — for Apple
silicon that is `voicevox_engine-macos-arm64-*.7z.001`, about 1.8 GB:

```bash
brew install p7zip
mkdir -p vendor && cd vendor
curl -L -O https://github.com/VOICEVOX/voicevox_engine/releases/download/0.25.2/voicevox_engine-macos-arm64-0.25.2.7z.001
7z x voicevox_engine-macos-arm64-0.25.2.7z.001
```

Then start it whenever you want Japanese speech:

```bash
npm run voicevox
```

Verity uses it automatically when it is running **and** the language is set to
Japanese, and picks the character voice in Settings › Voice. If the engine is not
running it falls back to the macOS voices rather than failing. It is never used
for English — given English text it reads the letters.

Two things worth knowing before you rely on it:

- **It is roughly realtime on CPU.** Measured on an M2: about 1.0–1.2× — a four
  second reply takes about four seconds to synthesise, on top of the time the
  model already took to think. It sounds far better than `say` and it is
  noticeably slower to start speaking.
- **Each character voice has its own usage terms.** Most are free to use with
  credit, but they differ per character. Read
  [the terms](https://voicevox.hiroshiba.jp/term/) before publishing anything
  made with them.

## Licence and attribution

The code is MIT — see [LICENSE](LICENSE).

The **Miku persona** uses the name and signature colour (`#39C5BB`) of Hatsune
Miku, a character owned by [Crypton Future Media](https://piapro.net/). Crypton
license the character under **Creative Commons BY-NC**, which permits
non-commercial derivative use with attribution. This project is non-commercial
and ships no artwork, audio or voicebank — only a name, a colour and a tone of
voice. It is unofficial and not affiliated with or endorsed by Crypton.

Third-party components, none of which are bundled here:

- [Ollama](https://ollama.com) and whichever models you pull, under their own licences
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) and the OpenAI Whisper models
- [Kiwix](https://kiwix.org) ZIM archives — Wikipedia content is CC BY-SA
- Weather from [Open-Meteo](https://open-meteo.com) (CC BY 4.0)

## Troubleshooting

**"Ollama off"** — run `brew services start ollama`.

**Microphone does nothing** — System Settings › Privacy & Security › Microphone,
enable Verity. macOS only asks once, and denying it is sticky.

**"No archive"** — the USB drive is unplugged, or the file is not `.zim`. Run
`npm run check-wikipedia` to test the archive directly.

**"No vault"** — Verity finds your vault by checking Obsidian's own registry and
then looking for a folder containing `.obsidian` in the usual places. Obsidian's
registry is not reliable — it happily keeps pointing at vaults that have since
been moved or deleted — so every candidate is checked against the disk before
being used. Override the path in Settings if it picks the wrong one.

**Replies are slow** — check which model is selected. A reasoning model is the
usual cause. Close other apps: 8 GB fills quickly.

**No sound** — check Settings › Voice › Play through, and that "Speak replies"
is on.
