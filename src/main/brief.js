'use strict';
/**
 * The morning brief.
 *
 * Gathers the day — calendar, outstanding reminders, weather — and has the local
 * model turn it into a few spoken sentences at a set time. This is the one thing
 * Verity does without being asked, so it is deliberately conservative: it never
 * fires twice in a day, it says nothing if there is nothing to say, and if the
 * model is unreachable it falls back to reading the facts out plainly rather
 * than staying silent.
 *
 * It only fires while Verity is running. There is a "start at login" setting to
 * make that likely; a background daemon that launches the app would be a larger
 * imposition than this feature is worth.
 */

const { load } = require('./config');
const macos = require('./tools/macos');
const { weather } = require('./tools/weather');
const ollama = require('./providers/ollama');

let timer = null;
let lastFired = null; // YYYY-MM-DD, so it cannot repeat within a day

function parseTime(value) {
  const m = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}

/** Everything the brief might mention. Each source fails independently. */
async function gather() {
  const cfg = load();
  const out = { events: [], reminders: [], weather: null, problems: [] };

  try {
    const calendar = await macos.calendarList({ days: cfg.brief.days || 1 });
    out.events = calendar.events || [];
  } catch (err) {
    out.problems.push(`calendar: ${err.message}`);
  }

  try {
    const reminders = await macos.remindersList({ limit: 10 });
    out.reminders = reminders.reminders || [];
  } catch (err) {
    out.problems.push(`reminders: ${err.message}`);
  }

  try {
    const location = cfg.brief.location || cfg.homeLocation || cfg.location.label || undefined;
    const forecast = await weather({ location, days: 1 });
    if (forecast.found) out.weather = forecast;
  } catch (err) {
    out.problems.push(`weather: ${err.message}`);
  }

  return out;
}

/** Plain reading of the facts, used when the model is unavailable. */
function fallbackText(data) {
  const parts = [];
  if (data.weather) {
    const c = data.weather.current;
    parts.push(`It is ${c.temperature} and ${c.conditions} in ${data.weather.location}.`);
  }
  if (data.events.length) {
    const first = data.events.slice(0, 3).map((e) => `${e.title} at ${e.startsAt}`).join(', ');
    parts.push(`You have ${data.events.length} thing${data.events.length === 1 ? '' : 's'} on: ${first}.`);
  } else {
    parts.push('Your calendar is clear.');
  }
  if (data.reminders.length) {
    parts.push(`${data.reminders.length} reminder${data.reminders.length === 1 ? '' : 's'} outstanding, including ${data.reminders[0].title}.`);
  }
  return parts.join(' ');
}

async function compose(data) {
  const cfg = load();
  const now = new Date();

  const facts = [
    `Time: ${now.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}`,
    data.weather
      ? `Weather in ${data.weather.location}: ${data.weather.current.temperature}, ${data.weather.current.conditions}, feels like ${data.weather.current.feelsLike}${
          data.weather.forecast?.[0] ? `, high ${data.weather.forecast[0].high} low ${data.weather.forecast[0].low}, ${data.weather.forecast[0].chanceOfRain || '0%'} chance of rain` : ''
        }`
      : 'Weather: unavailable',
    data.events.length
      ? `Calendar:\n${data.events.map((e) => `- ${e.title} — ${e.startsAt}`).join('\n')}`
      : 'Calendar: nothing scheduled',
    data.reminders.length
      ? `Reminders outstanding:\n${data.reminders.map((r) => `- ${r.title}${r.due ? ` (due ${r.due})` : ''}`).join('\n')}`
      : 'Reminders: none outstanding',
  ].join('\n\n');

  const messages = [
    {
      role: 'system',
      content: [
        'You read a short morning brief aloud. It will be spoken, not shown.',
        '',
        '- Three or four sentences. No more.',
        '- Plain prose. No markdown, no bullets, no headings, no times written as 09:00 — say "nine".',
        '- Lead with anything time-critical. Mention the weather only if it would change what someone wears or carries.',
        '- State only what the facts below say. Do not invent anything, and do not offer to help.',
        '- No greeting beyond a brief one, and no sign-off.',
      ].join('\n'),
    },
    { role: 'user', content: `Read me my brief from these facts:\n\n${facts}` },
  ];

  try {
    const result = await ollama.chat({ model: cfg.model, messages, tools: [] });
    const text = (result.content || '').trim();
    return text.length > 20 ? text : fallbackText(data);
  } catch {
    return fallbackText(data);
  }
}

/** Build and deliver the brief now, regardless of schedule. */
async function run({ onBrief } = {}) {
  const data = await gather();
  const text = await compose(data);
  lastFired = new Date().toISOString().slice(0, 10);
  if (onBrief) onBrief({ text, data });
  return { text, data };
}

/**
 * Check once a minute whether the brief is due. A minute of granularity is
 * plenty, and it costs nothing compared with computing when to next wake up
 * across sleep, timezone changes and settings edits.
 */
function start({ onBrief }) {
  stop();
  timer = setInterval(() => {
    const cfg = load();
    if (!cfg.brief?.enabled) return;

    const at = parseTime(cfg.brief.time);
    if (!at) return;

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (lastFired === today) return;
    if (now.getHours() !== at.hours || now.getMinutes() !== at.minutes) return;

    run({ onBrief }).catch(() => {
      // Never let a failed brief kill the schedule; try again tomorrow.
      lastFired = today;
    });
  }, 60000);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, run, gather, compose, parseTime, fallbackText };
