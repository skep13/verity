'use strict';
/**
 * macOS integration: Calendar, Reminders, timers, Spotlight and opening things.
 *
 * Everything here goes through AppleScript or a command-line tool rather than a
 * native module, which keeps the project free of anything that has to compile
 * and means it works against whatever versions of Calendar and Reminders the
 * system already has.
 *
 * The first call to Calendar or Reminders raises a macOS Automation prompt. If
 * it is declined the error is caught and explained rather than surfacing as a
 * bare AppleScript number.
 */

const { execFile } = require('child_process');
const path = require('path');
const os = require('os');

/**
 * Start an app if it is closed, and wait until it will answer AppleScript.
 *
 * AppleScript's own `launch` and `activate` do not reliably start sandboxed
 * system apps — Calendar returns -600 "Application isn't running" no matter how
 * long you wait, while `open -a` starts it immediately. `-g` keeps it in the
 * background rather than stealing focus from whatever the user is doing.
 *
 * Reminders needs this too, though it recovers on its own more readily.
 */
async function ensureAppRunning(appName, timeoutMs = 8000) {
  try {
    await execFileAsync('/usr/bin/open', ['-g', '-a', appName], 8000);
  } catch {
    // Already running, or not installed — the poll below decides which.
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await osa(`tell application "${appName}" to return true`, 4000);
      return true;
    } catch (err) {
      if (Date.now() >= deadline) {
        throw new Error(`${appName} would not start, so Verity cannot read it. (${err.message.slice(0, 60)})`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

function execFileAsync(cmd, args, timeout = 10000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** Escape a string for embedding in an AppleScript double-quoted literal. */
const q = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function osa(script, timeout = 25000) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || '').trim();
        if (/not authori[sz]|not allowed|-1743|-10004/i.test(msg)) {
          reject(
            new Error(
              'macOS has not given Verity permission to control that app. Open System Settings › Privacy & Security › Automation, switch it on for Verity, then ask again.'
            )
          );
        } else if (err.killed) {
          reject(new Error('That app took too long to respond. It may be syncing — try again in a moment.'));
        } else {
          reject(new Error(msg.split('\n')[0] || 'AppleScript failed'));
        }
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

/**
 * Build AppleScript that assigns an absolute date to `name`.
 * Day is reset to 1 first: setting the month while the day is the 31st rolls the
 * date into the following month.
 */
function appleDate(name, date) {
  return [
    `set ${name} to (current date)`,
    `set day of ${name} to 1`,
    `set year of ${name} to ${date.getFullYear()}`,
    `set month of ${name} to ${date.getMonth() + 1}`,
    `set day of ${name} to ${date.getDate()}`,
    `set hours of ${name} to ${date.getHours()}`,
    `set minutes of ${name} to ${date.getMinutes()}`,
    `set seconds of ${name} to 0`,
  ].join('\n');
}

/** Parse what a model is likely to send. ISO 8601 is what we ask for. */
function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d;
  // "2026-08-12 14:00" without the T is common enough to be worth handling.
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return null;
}

/**
 * Times handed back to the model are formatted for a person, not a machine.
 * Given an ISO string a model will read it out verbatim, and "twenty twenty six
 * dash oh eight dash oh seven T eighteen twenty six" is not an answer.
 */
const humanTime = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const humanDateTime = (d) =>
  d.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

const BAD_DATE =
  'That date could not be understood. Supply an ISO 8601 datetime such as 2026-08-12T14:00, and call the datetime tool first if you need to know what "tomorrow" is.';

/* ------------------------------------------------------------------ */
/* Calendar                                                            */
/* ------------------------------------------------------------------ */

async function calendarList({ days = 1 } = {}) {
  await ensureAppRunning('Calendar');
  const span = Math.min(Math.max(Number(days) || 1, 1), 31);
  const start = new Date();
  const end = new Date(start.getTime() + span * 86400000);

  const script = `
${appleDate('d1', start)}
set hours of d1 to 0
set minutes of d1 to 0
${appleDate('d2', end)}
set hours of d2 to 23
set minutes of d2 to 59
tell application "Calendar"
  set out to ""
  repeat with c in calendars
    repeat with e in (every event of c whose start date >= d1 and start date <= d2)
      set out to out & (summary of e) & "\t" & ((start date of e) as string) & "\t" & ((end date of e) as string) & "\t" & (name of c) & linefeed
    end repeat
  end repeat
  return out
end tell`;

  const raw = await osa(script, 40000);
  const events = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [title, startsAt, endsAt, calendar] = line.split('\t');
      return { title, startsAt, endsAt, calendar };
    })
    // Calendar returns them grouped per calendar, which is not chronological.
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));

  return {
    from: start.toISOString().slice(0, 10),
    days: span,
    count: events.length,
    events,
    note: events.length ? undefined : `Nothing in the calendar for the next ${span} day(s).`,
  };
}

async function calendarAdd({ title, start, end, notes, calendar }) {
  await ensureAppRunning('Calendar');
  if (!title) throw new Error('An event needs a title.');
  const startDate = parseDate(start);
  if (!startDate) throw new Error(BAD_DATE);
  // Default to an hour, which is what people mean when they do not say.
  const endDate = parseDate(end) || new Date(startDate.getTime() + 3600000);

  // Resolve the calendar to a variable first and read its name from there. An
  // event has no reachable "container" once created, so asking it which calendar
  // it landed in fails.
  const target = calendar
    ? `calendar "${q(calendar)}"`
    : '(the first calendar whose writable is true)';

  const script = `
${appleDate('d1', startDate)}
${appleDate('d2', endDate)}
tell application "Calendar"
  set targetCal to ${target}
  set calName to name of targetCal
  tell targetCal
    make new event with properties {summary:"${q(title)}", start date:d1, end date:d2${
      notes ? `, description:"${q(notes)}"` : ''
    }}
  end tell
  return calName
end tell`;

  const savedCalendar = await osa(script);
  return {
    created: true,
    title,
    calendar: savedCalendar || calendar || 'default',
    startsAt: humanDateTime(startDate),
    endsAt: humanTime(endDate),
  };
}

/* ------------------------------------------------------------------ */
/* Reminders                                                           */
/* ------------------------------------------------------------------ */

async function reminderAdd({ title, due, notes }) {
  await ensureAppRunning('Reminders');
  if (!title) throw new Error('A reminder needs a title.');
  const dueDate = due ? parseDate(due) : null;
  if (due && !dueDate) throw new Error(BAD_DATE);

  const script = `
${dueDate ? appleDate('d1', dueDate) : ''}
tell application "Reminders"
  set r to make new reminder with properties {name:"${q(title)}"${
    dueDate ? ', due date:d1' : ''
  }${notes ? `, body:"${q(notes)}"` : ''}}
  return name of r
end tell`;

  const saved = await osa(script);
  return { created: true, title: saved || title, due: dueDate ? humanDateTime(dueDate) : null };
}

async function remindersList({ includeCompleted = false, limit = 25 } = {}) {
  await ensureAppRunning('Reminders');
  const script = `
tell application "Reminders"
  set out to ""
  repeat with r in (every reminder${includeCompleted ? '' : ' whose completed is false'})
    set dueText to ""
    try
      set dueText to ((due date of r) as string)
    end try
    set out to out & (name of r) & "\t" & dueText & linefeed
  end repeat
  return out
end tell`;

  const raw = await osa(script, 30000);
  const items = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, Math.min(Number(limit) || 25, 50))
    .map((line) => {
      const [title, due] = line.split('\t');
      // AppleScript renders an unset property as the literal "missing value";
      // passed through, a model reads that back as if it were the due date.
      const clean = due && due !== 'missing value' ? due : null;
      return { title, due: clean };
    });

  return {
    count: items.length,
    reminders: items,
    note: items.length ? undefined : 'Nothing outstanding in Reminders.',
  };
}

/* ------------------------------------------------------------------ */
/* Clipboard                                                           */
/* ------------------------------------------------------------------ */

/**
 * Read whatever was last copied.
 *
 * Deliberately permission-gated: a clipboard routinely holds a password, a
 * recovery code or a card number seconds after it was copied, and that should
 * not reach a model because a question was phrased loosely.
 */
function clipboardRead({ maxChars = 4000 } = {}) {
  const { clipboard } = require('electron');
  const text = clipboard.readText();
  if (!text || !text.trim()) {
    return { empty: true, note: 'The clipboard is empty, or holds something that is not text.' };
  }
  const truncated = text.length > maxChars;
  return {
    empty: false,
    chars: text.length,
    truncated,
    content: truncated ? `${text.slice(0, maxChars)}\n[…clipboard truncated]` : text,
  };
}

function clipboardWrite({ text }) {
  const value = String(text ?? '');
  if (!value) throw new Error('Nothing to copy.');
  const { clipboard } = require('electron');
  clipboard.writeText(value);
  return { copied: true, chars: value.length };
}

/* ------------------------------------------------------------------ */
/* Timers                                                              */
/* ------------------------------------------------------------------ */

const timers = new Map();
let timerSeq = 0;
// Set by the main process so a finished timer can speak and show a notification.
let onTimerElapsed = null;

function setTimerHandler(fn) {
  onTimerElapsed = fn;
}

function timerSet({ minutes, label }) {
  const mins = Number(minutes);
  if (!Number.isFinite(mins) || mins <= 0 || mins > 1440) {
    throw new Error('Give a duration in minutes, between 0 and 1440.');
  }
  const id = ++timerSeq;
  const name = label || `${mins} minute timer`;
  const firesAt = new Date(Date.now() + mins * 60000);

  const handle = setTimeout(() => {
    timers.delete(id);
    if (onTimerElapsed) onTimerElapsed({ id, label: name });
  }, mins * 60000);
  // Do not hold the app open purely because a timer is pending.
  if (handle.unref) handle.unref();

  timers.set(id, { id, label: name, firesAt, handle });
  return {
    set: true,
    id,
    label: name,
    firesAt: humanTime(firesAt),
    note: 'Timers live only while Verity is open. Use a reminder for anything that must survive a restart.',
  };
}

function timerList() {
  const active = [...timers.values()].map((t) => ({
    id: t.id,
    label: t.label,
    firesAt: humanTime(t.firesAt),
    minutesLeft: Math.max(0, Math.round((t.firesAt - Date.now()) / 60000)),
  }));
  return { count: active.length, timers: active };
}

function timerCancel({ id }) {
  const t = timers.get(Number(id));
  if (!t) return { cancelled: false, note: `No timer with id ${id}.` };
  clearTimeout(t.handle);
  timers.delete(t.id);
  return { cancelled: true, label: t.label };
}

/* ------------------------------------------------------------------ */
/* Spotlight and opening things                                        */
/* ------------------------------------------------------------------ */

// Spotlight indexes plenty the user did not mean; these are never useful here.
const NOISE = /\/(Library|System|node_modules|\.git|Applications\/[^/]+\.app\/)/;

function filesSearch({ query, limit = 10 }) {
  return new Promise((resolve, reject) => {
    const text = String(query || '').trim();
    if (!text) {
      reject(new Error('Give something to search for.'));
      return;
    }
    execFile(
      '/usr/bin/mdfind',
      ['-onlyin', os.homedir(), text],
      { timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) {
          reject(new Error('Spotlight search failed.'));
          return;
        }
        const files = String(stdout)
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !NOISE.test(l))
          .slice(0, Math.min(Number(limit) || 10, 25))
          .map((p) => ({ name: path.basename(p), path: p }));
        resolve({
          count: files.length,
          files,
          note: files.length ? undefined : `Nothing on this Mac matched "${text}".`,
        });
      }
    );
  });
}

function openItem({ target }) {
  return new Promise((resolve, reject) => {
    const value = String(target || '').trim();
    if (!value) {
      reject(new Error('Nothing to open.'));
      return;
    }
    // Only ordinary web links and things on this Mac. Arbitrary URL schemes can
    // trigger side effects in other apps, which is not what "open" should mean.
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^(https?|file):/i.test(value)) {
      reject(new Error('Only http, https and file locations can be opened.'));
      return;
    }
    execFile('/usr/bin/open', [value], { timeout: 10000 }, (err) => {
      if (err) {
        reject(new Error(`Could not open "${value}". It may not exist.`));
        return;
      }
      resolve({ opened: true, target: value });
    });
  });
}

module.exports = {
  calendarList,
  calendarAdd,
  reminderAdd,
  remindersList,
  clipboardRead,
  clipboardWrite,
  timerSet,
  timerList,
  timerCancel,
  filesSearch,
  openItem,
  setTimerHandler,
};
