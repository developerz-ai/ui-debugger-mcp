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
    '## Your tool belt',
    '- `observe` — read state',
    '- `report` — emit the final structured findings and STOP.',
    '## Structure-first rule',
    'Never screenshot for information you can read from the tree or logs.',
    '## Terminal `report` call',
    WEB_ADDENDUM_PROMPT.slice(0, 80),
  ]) {
    expect(vision).toContain(shared);
    expect(self).toContain(shared);
  }
});
