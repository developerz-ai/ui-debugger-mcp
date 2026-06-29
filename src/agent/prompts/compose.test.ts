import { expect, test } from 'bun:test';
import { composeSystemPrompt } from './compose.js';
import { DEBUG_AGENT_BASE_PROMPT } from './debug-agent.js';
import { DESKTOP_ADDENDUM_PROMPT } from './desktop-addendum.js';
import { WEB_ADDENDUM_PROMPT } from './web-addendum.js';

test('composeSystemPrompt: includes the base debug-agent prompt', () => {
  const prompt = composeSystemPrompt({ target: 'web', story: 'Test the login flow.' });
  // Base prompt content is present
  expect(prompt).toContain(DEBUG_AGENT_BASE_PROMPT.slice(0, 80));
});

test('composeSystemPrompt: includes the web addendum for target=web', () => {
  const prompt = composeSystemPrompt({ target: 'web', story: 'Test the login flow.' });
  expect(prompt).toContain(WEB_ADDENDUM_PROMPT.slice(0, 80));
});

test('composeSystemPrompt: includes the desktop addendum for target=desktop', () => {
  const prompt = composeSystemPrompt({ target: 'desktop', story: 'Open the settings dialog.' });
  expect(prompt).toContain(DESKTOP_ADDENDUM_PROMPT.slice(0, 80));
  // Not the web one — addenda are mutually exclusive per target.
  expect(prompt).not.toContain(WEB_ADDENDUM_PROMPT.slice(0, 80));
});

test('composeSystemPrompt: includes the story', () => {
  const story = 'Log in as test@example.com and verify the dashboard loads.';
  const prompt = composeSystemPrompt({ target: 'web', story });
  expect(prompt).toContain(story);
});

test('composeSystemPrompt: includes criteria when provided', () => {
  const criteria = ['No JS errors in the console', 'Checkout button is visible and enabled'];
  const prompt = composeSystemPrompt({ target: 'web', story: 'Buy item #3.', criteria });
  expect(prompt).toContain('No JS errors in the console');
  expect(prompt).toContain('Checkout button is visible and enabled');
  // Numbered list
  expect(prompt).toContain('1. No JS errors');
  expect(prompt).toContain('2. Checkout button');
});

test('composeSystemPrompt: omits criteria section when criteria is empty array', () => {
  const prompt = composeSystemPrompt({ target: 'web', story: 'Test something.', criteria: [] });
  expect(prompt).not.toContain('Pass / fail criteria');
});

test('composeSystemPrompt: omits criteria section when criteria is undefined', () => {
  const prompt = composeSystemPrompt({ target: 'web', story: 'Test something.' });
  expect(prompt).not.toContain('Pass / fail criteria');
});

test('composeSystemPrompt: sections are separated by dividers', () => {
  const prompt = composeSystemPrompt({ target: 'web', story: 'Test.', criteria: ['Criterion A'] });
  expect(prompt).toContain('---');
});

test('composeSystemPrompt: story section has correct heading', () => {
  const prompt = composeSystemPrompt({ target: 'web', story: 'Navigate to /settings.' });
  expect(prompt).toContain('## Your goal for this session');
  expect(prompt).toContain('Navigate to /settings.');
});

test('composeSystemPrompt: criteria section has correct heading', () => {
  const prompt = composeSystemPrompt({
    target: 'web',
    story: 'Test.',
    criteria: ['Page loads under 2s'],
  });
  expect(prompt).toContain('## Pass / fail criteria');
});

test('composeSystemPrompt: trims whitespace from story', () => {
  const prompt = composeSystemPrompt({ target: 'web', story: '  Trimmed story.  ' });
  expect(prompt).toContain('Trimmed story.');
});
