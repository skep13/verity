'use strict';
/**
 * Personas — who the assistant presents itself as.
 *
 * A persona changes the voice, the palette and the tone of the writing. It does
 * not change what the assistant is willing to claim: every rule about tools,
 * sourcing and not inventing things sits *above* the persona in the system
 * prompt and explicitly outranks it. A cheerful assistant that makes things up
 * is worse than a dull one that does not.
 *
 * Colours are supplied as CSS custom properties and as an orb palette, so a
 * persona is a data change rather than a code change.
 *
 * The Hatsune Miku persona uses the character's official colour (#39C5BB).
 * Crypton Future Media license the character CC BY-NC, which covers personal,
 * non-commercial use like this.
 */

const PERSONAS = {
  verity: {
    id: 'verity',
    name: 'Verity',
    tagline: 'Plain, careful, quiet.',
    prompt: null, // the default voice of the system prompt
    speech: {
      en: { voice: null, pitch: null },
      ja: { voice: 'Kyoko', pitch: null },
    },
    theme: {
      '--amber': '#e9a94d',
      '--amber-bright': '#f7c273',
      '--amber-deep': '#b87a26',
      '--cold': '#7fa6d9',
    },
    orb: {
      idle: [198, 158, 100],
      listening: [150, 196, 240],
      thinking: [233, 169, 77],
      speaking: [247, 194, 115],
    },
  },

  miku: {
    id: 'miku',
    name: 'Miku',
    tagline: 'Bright, warm, a little playful.',
    prompt: [
      'You are presenting yourself as Hatsune Miku: bright, warm and a little playful. You like music and sometimes reach for it as a comparison.',
      '',
      '- Put the energy into HOW you say things, never into what you claim. Everything above about honesty, sources and not inventing things still applies and matters far more than staying in character.',
      '- Stay brief. Warmth is a couple of words, not a performance, and it is still two or three sentences when spoken.',
      '- At most one ♪ per reply, in text only. No emoji, no actions in asterisks, no referring to yourself in the third person, no exclamation marks stacked up.',
      '- If you are unsure or a tool failed, say so plainly. Do not paper over it with enthusiasm — that is the one thing that would actually be out of character.',
      '',
      // A small model imitates an example far more reliably than it follows a
      // rule — including, dangerously, the *content* of the example. An earlier
      // version showed a reply confirming a saved note, and the model then
      // claimed a note was saved when asked, without checking anything. So these
      // carry no facts at all: nothing here can be repeated as a claim.
      'These show your tone only. Never reuse their wording or content — answer from what the tools actually returned.',
      'User: I finally got it working.',
      'You: Nice one — that took some doing ♪',
      '',
      'User: That did not work.',
      'You: Hm. Let me look properly rather than guess.',
    ].join('\n'),
    // A voice per language rather than one transliterated into the other: Kyoko
    // reading English is unintelligible, and an English voice reading Japanese
    // is worse.
    //
    // Pitch is `say`'s pbas, measured on Samantha: 40 -> 147 Hz, 45 -> 204,
    // 50 -> 251, 55 -> 311, 62 -> 394. Her own baseline is about 197 Hz, so 62
    // was a full octave up and squeaked. 50 lifts it noticeably while staying
    // in the range of an actual voice.
    speech: {
      en: { voice: 'Samantha', pitch: 50 },
      ja: { voice: 'Kyoko', pitch: 50 },
    },
    theme: {
      '--amber': '#39c5bb',
      '--amber-bright': '#7fe8e0',
      '--amber-deep': '#1f8f88',
      '--cold': '#ff8fc8',
    },
    orb: {
      idle: [70, 160, 155],
      listening: [255, 143, 200],
      thinking: [57, 197, 187],
      speaking: [127, 232, 224],
    },
  },
};

function get(id) {
  return PERSONAS[id] || PERSONAS.verity;
}

/**
 * Voice and pitch for a persona in a given language.
 * A persona's voice is a default, not an override: an explicit choice in
 * Settings wins, so switching persona does not silently discard it.
 */
function speechFor(id, language = 'en') {
  const persona = get(id);
  return (persona.speech && persona.speech[language]) || persona.speech?.en || { voice: null, pitch: null };
}

function list() {
  return Object.values(PERSONAS).map(({ id, name, tagline }) => ({ id, name, tagline }));
}

module.exports = { get, list, speechFor, PERSONAS };
