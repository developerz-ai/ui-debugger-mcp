import { expect, test } from 'bun:test';
import { ANDROID_ADDENDUM_PROMPT } from './android-addendum.js';
import { composeSystemPrompt } from './compose.js';
import { debugAgentPrompt } from './debug-agent.js';
import { DESKTOP_ADDENDUM_PROMPT } from './desktop-addendum.js';
import { WEB_ADDENDUM_PROMPT } from './web-addendum.js';

test('composeSystemPrompt: includes the base debug-agent prompt', () => {
  const prompt = composeSystemPrompt({
    target: 'web',
    story: 'Test the login flow.',
    selfLook: false,
  });
  // Base prompt content is present
  expect(prompt).toContain(debugAgentPrompt(false).slice(0, 80));
});

test('composeSystemPrompt: includes the web addendum for target=web', () => {
  const prompt = composeSystemPrompt({
    target: 'web',
    story: 'Test the login flow.',
    selfLook: false,
  });
  expect(prompt).toContain(WEB_ADDENDUM_PROMPT.slice(0, 80));
});

test('composeSystemPrompt: includes the desktop addendum for target=desktop', () => {
  const prompt = composeSystemPrompt({
    target: 'desktop',
    story: 'Open the settings dialog.',
    selfLook: false,
  });
  expect(prompt).toContain(DESKTOP_ADDENDUM_PROMPT.slice(0, 80));
  // Not the web one — addenda are mutually exclusive per target.
  expect(prompt).not.toContain(WEB_ADDENDUM_PROMPT.slice(0, 80));
});

test('composeSystemPrompt: includes the android addendum for target=android', () => {
  const prompt = composeSystemPrompt({
    target: 'android',
    story: 'Open com.example.app and log in.',
    selfLook: false,
  });
  expect(prompt).toContain(ANDROID_ADDENDUM_PROMPT.slice(0, 80));
  // Not the web one — addenda are mutually exclusive per target.
  expect(prompt).not.toContain(WEB_ADDENDUM_PROMPT.slice(0, 80));
});

test('composeSystemPrompt: includes the story', () => {
  const story = 'Log in as test@example.com and verify the dashboard loads.';
  const prompt = composeSystemPrompt({ target: 'web', story, selfLook: false });
  expect(prompt).toContain(story);
});

// A driver with no address in its context invented one from the goal text and
// debugged a stranger's production site for a whole run. Telling it where it is
// is half the fix (the other half is `act` refusing to leave).
test('composeSystemPrompt: states the app under test and forbids leaving it', () => {
  const prompt = composeSystemPrompt({
    target: 'web',
    story: 'Debug the Nimbus Store home page.',
    selfLook: false,
    address: 'http://127.0.0.1:5179',
  });
  expect(prompt).toContain('## The app under test');
  expect(prompt).toContain('http://127.0.0.1:5179');
  expect(prompt).toMatch(/never navigate to (any other|another) host/i);
});

test('composeSystemPrompt: omits the address section for targets without one', () => {
  const prompt = composeSystemPrompt({
    target: 'android',
    story: 'Open the app.',
    selfLook: false,
  });
  expect(prompt).not.toContain('## The app under test');
});

// --- the signed-in section (`start_debug({as})`) -----------------------------

test('composeSystemPrompt: tells the driver it is already signed in as the persona', () => {
  const prompt = composeSystemPrompt({
    target: 'web',
    story: 'Open Audit and check the table.',
    selfLook: false,
    auth: { persona: 'admin', loginPath: '/login' },
  });
  expect(prompt).toContain('## Signed in');
  expect(prompt).toContain('`admin`');
  expect(prompt).toContain('/login');
  // The whole point: it must not spend steps re-doing a login that already happened.
  expect(prompt).toMatch(/CANNOT log in again/);
});

test('composeSystemPrompt: the signed-in section carries NAMES, never credentials', () => {
  // The system prompt is resent to the provider on EVERY step. The repo's standing
  // rule for a secret is that it never reaches the model's context — the login runs
  // out-of-band precisely so this section can be name-only.
  const prompt = composeSystemPrompt({
    target: 'web',
    story: 'Test.',
    selfLook: false,
    auth: { persona: 'admin', loginPath: '/login' },
  });
  // `ComposeOptions.auth` structurally cannot carry a value — it takes a name and a
  // path. This pins that: nothing field-shaped reaches the section.
  const section = prompt.split('## Signed in')[1]?.split('\n---')[0] ?? '';
  expect(section).not.toBe('');
  for (const leak of ['@', 'password', 'field']) {
    expect(section.includes(leak)).toBe(false);
  }
});

test('composeSystemPrompt: omits the signed-in section for a run with no persona', () => {
  const prompt = composeSystemPrompt({ target: 'web', story: 'Test.', selfLook: false });
  expect(prompt).not.toContain('## Signed in');
});

// --- the target's standing notes (what is EXPECTED of this app) --------------

test('composeSystemPrompt: states the project notes as expected, not as defects', () => {
  // The false positive this exists for: a freshly-migrated app with no seed data
  // renders empty states everywhere, and the driver files "the table is empty" as
  // the run's headline bug.
  const prompt = composeSystemPrompt({
    target: 'web',
    story: 'Open /users and check the table.',
    selfLook: false,
    notes: ['needs seeded data — empty tables are expected on /new', 'dark mode by default'],
  });
  expect(prompt).toContain('## Known about this app');
  expect(prompt).toContain('- needs seeded data — empty tables are expected on /new');
  expect(prompt).toContain('- dark mode by default');
  expect(prompt).toMatch(/NEVER\s+`report` one as a bug/);
  // …but a note is not a gag order: something contradicting one is still a finding.
  expect(prompt).toMatch(/CONTRADICTS/);
});

test('composeSystemPrompt: omits the notes section when the target declares none', () => {
  expect(composeSystemPrompt({ target: 'web', story: 'Test.', selfLook: false })).not.toContain(
    '## Known about this app',
  );
  expect(
    composeSystemPrompt({ target: 'web', story: 'Test.', selfLook: false, notes: [] }),
  ).not.toContain('## Known about this app');
});

test('composeSystemPrompt: notes are app context, so they precede the run goal', () => {
  // Ordering is the whole point of "stated once": the driver reads what is true of
  // the app, THEN what it is being asked to do this run.
  const prompt = composeSystemPrompt({
    target: 'web',
    story: 'Open /users.',
    selfLook: false,
    notes: ['seed data is required'],
  });
  expect(prompt.indexOf('## Known about this app')).toBeLessThan(
    prompt.indexOf('## Your goal for this session'),
  );
});

test('composeSystemPrompt: includes criteria when provided', () => {
  const criteria = ['No JS errors in the console', 'Checkout button is visible and enabled'];
  const prompt = composeSystemPrompt({
    target: 'web',
    story: 'Buy item #3.',
    criteria,
    selfLook: false,
  });
  expect(prompt).toContain('No JS errors in the console');
  expect(prompt).toContain('Checkout button is visible and enabled');
  // Numbered list
  expect(prompt).toContain('1. No JS errors');
  expect(prompt).toContain('2. Checkout button');
});

test('composeSystemPrompt: omits criteria section when criteria is empty array', () => {
  const prompt = composeSystemPrompt({
    target: 'web',
    story: 'Test something.',
    criteria: [],
    selfLook: false,
  });
  expect(prompt).not.toContain('Pass / fail criteria');
});

test('composeSystemPrompt: omits criteria section when criteria is undefined', () => {
  const prompt = composeSystemPrompt({ target: 'web', story: 'Test something.', selfLook: false });
  expect(prompt).not.toContain('Pass / fail criteria');
});

test('composeSystemPrompt: sections are separated by dividers', () => {
  const prompt = composeSystemPrompt({
    target: 'web',
    story: 'Test.',
    criteria: ['Criterion A'],
    selfLook: false,
  });
  expect(prompt).toContain('---');
});

test('composeSystemPrompt: story section has correct heading', () => {
  const prompt = composeSystemPrompt({
    target: 'web',
    story: 'Navigate to /settings.',
    selfLook: false,
  });
  expect(prompt).toContain('## Your goal for this session');
  expect(prompt).toContain('Navigate to /settings.');
});

test('composeSystemPrompt: criteria section has correct heading', () => {
  const prompt = composeSystemPrompt({
    target: 'web',
    story: 'Test.',
    criteria: ['Page loads under 2s'],
    selfLook: false,
  });
  expect(prompt).toContain('## Pass / fail criteria');
});

test('composeSystemPrompt: trims whitespace from story', () => {
  const prompt = composeSystemPrompt({
    target: 'web',
    story: '  Trimmed story.  ',
    selfLook: false,
  });
  expect(prompt).toContain('Trimmed story.');
});

test('every target learns that `type` appends unless you pass clear:true', () => {
  // `act`'s `clear` is built from generic contract verbs and works on all three
  // targets, but the guidance used to live in the web addendum alone — so an
  // android retry into a pre-filled EditText produced `TestPass1TestPass1` and the
  // driver reported the doubling as an app bug (the exact false positive the base
  // prompt warns about).
  for (const target of ['web', 'desktop', 'android'] as const) {
    const prompt = composeSystemPrompt({ target, story: 'Test.', selfLook: false });
    expect(prompt).toContain('clear: true');
    expect(prompt).toContain('clear:true');
  }
});

// --- eye mode (selfLook) — the prompt must describe the `look` tool actually bound ---

/** Phrases that are TRUE only when a separate vision model answers `look`. */
const VISION_ONLY =
  /blind|vision (model|guy)|Vision tokens are expensive|reports it is unavailable/i;

test('composeSystemPrompt: selfLook=false keeps the blind-driver / vision-guy prompt', () => {
  const prompt = composeSystemPrompt({ target: 'web', story: 'Test.', selfLook: false });
  expect(prompt).toContain('You are FAST and BLIND: you NEVER see pixels.');
  expect(prompt).toContain('ask the vision model to describe/judge a screenshot');
  expect(prompt).toContain('Vision tokens are expensive.');
  // The vision latch (`createLookExecute`) exists only in this mode.
  expect(prompt).toContain('If `look` reports it is unavailable for this run');
});

test('composeSystemPrompt: selfLook=true says the driver judges the frame itself', () => {
  const prompt = composeSystemPrompt({ target: 'web', story: 'Test.', selfLook: true });
  expect(prompt).toContain('You are FAST and MULTIMODAL');
  expect(prompt).toContain('YOU judge it with your own eyes');
  expect(prompt).toContain('capture the current screen and judge it yourself');
  expect(prompt).toContain('Only the newest frame stays in your context');
});

test('composeSystemPrompt: selfLook=true drops every blind / vision-guy claim', () => {
  for (const target of ['web', 'desktop', 'android'] as const) {
    const prompt = composeSystemPrompt({ target, story: 'Test.', selfLook: true });
    expect(prompt).not.toMatch(VISION_ONLY);
  }
});

test('composeSystemPrompt: both eye modes share the rest of the prompt', () => {
  const base = { target: 'web', story: 'Test.' } as const;
  const vision = composeSystemPrompt({ ...base, selfLook: false });
  const self = composeSystemPrompt({ ...base, selfLook: true });
  expect(vision).not.toBe(self);
  for (const shared of [
    '## Tool belt',
    '- `observe` — read state',
    '- `report` — emit final findings and STOP.',
    '## Structure first — never screenshot what you can read',
    '## Terminal `report` call',
    WEB_ADDENDUM_PROMPT.slice(0, 80),
  ]) {
    expect(vision).toContain(shared);
    expect(self).toContain(shared);
  }
});
