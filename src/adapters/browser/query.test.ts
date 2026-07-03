import { expect, test } from 'bun:test';
import { normalizeQuery } from './query.js';

test('passes explicit Playwright engines through verbatim', () => {
  expect(normalizeQuery('text=Add to cart')).toBe('text=Add to cart');
  expect(normalizeQuery('role=button[name="Save"]')).toBe('role=button[name="Save"]');
  expect(normalizeQuery('css=.btn')).toBe('css=.btn');
  expect(normalizeQuery('data-testid=cart')).toBe('data-testid=cart');
});

test('passes XPath through verbatim', () => {
  expect(normalizeQuery('//button[1]')).toBe('//button[1]');
  expect(normalizeQuery('(//a)[2]')).toBe('(//a)[2]');
});

test('maps role + quoted name onto the role engine (case-insensitive)', () => {
  expect(normalizeQuery('button "Add to cart"')).toBe('role=button[name="Add to cart" i]');
  expect(normalizeQuery("link 'About'")).toBe('role=link[name="About" i]');
  expect(normalizeQuery('heading "Nimbus Store"')).toBe('role=heading[name="Nimbus Store" i]');
});

test('keeps real CSS selectors as CSS', () => {
  expect(normalizeQuery('.add-to-cart')).toBe('.add-to-cart');
  expect(normalizeQuery('.class')).toBe('.class');
  expect(normalizeQuery('#submit')).toBe('#submit');
  expect(normalizeQuery('#id')).toBe('#id');
  expect(normalizeQuery('button.add')).toBe('button.add');
  expect(normalizeQuery('div.card')).toBe('div.card');
  expect(normalizeQuery('a:hover')).toBe('a:hover');
  expect(normalizeQuery('input[type=text]')).toBe('input[type=text]');
  expect(normalizeQuery('[data-id="3"]')).toBe('[data-id="3"]');
  expect(normalizeQuery('nav > a')).toBe('nav > a');
  expect(normalizeQuery('div > .foo')).toBe('div > .foo');
  expect(normalizeQuery('button:has-text("x")')).toBe('button:has-text("x")');
});

test('does not misclassify labels as role= or CSS (narrowed heuristics)', () => {
  // First token is not an ARIA role → a quoted label, not role=
  expect(normalizeQuery('Sale "50% off"')).toBe('text=Sale "50% off"');
  // A combinator not flanked by simple selectors on both sides stays text
  expect(normalizeQuery('Next >')).toBe('text=Next >');
  expect(normalizeQuery('A ~ B')).toBe('text=A ~ B');
});

test('word + trailing punctuation is visible text, not CSS', () => {
  // `.`/`:` after a word only reads as CSS with a selector-ish continuation —
  // ellipses, trailing dots, and `label: value` prose stay on the text engine.
  expect(normalizeQuery('Loading...')).toBe('text=Loading...');
  expect(normalizeQuery('Loading.')).toBe('text=Loading.');
  expect(normalizeQuery('Error: payment failed')).toBe('text=Error: payment failed');
});

test('falls back to the text engine for plain visible text', () => {
  expect(normalizeQuery('Add to cart')).toBe('text=Add to cart');
  expect(normalizeQuery('Subscribe')).toBe('text=Subscribe');
  expect(normalizeQuery('Join the Nimbus list')).toBe('text=Join the Nimbus list');
});

test('trims surrounding whitespace', () => {
  expect(normalizeQuery('  Add to cart  ')).toBe('text=Add to cart');
  expect(normalizeQuery('  .btn ')).toBe('.btn');
});

test('empty string stays empty (caller decides what that means)', () => {
  expect(normalizeQuery('')).toBe('');
  expect(normalizeQuery('   ')).toBe('');
});

test('bare HTML tag names resolve as CSS, not text', () => {
  expect(normalizeQuery('span')).toBe('span');
  expect(normalizeQuery('img')).toBe('img');
  expect(normalizeQuery('div')).toBe('div');
  expect(normalizeQuery('Span')).toBe('span'); // case-insensitive
  expect(normalizeQuery('  header ')).toBe('header');
});

test('multi-word or non-tag single words still fall back to text', () => {
  expect(normalizeQuery('Contact')).toBe('text=Contact');
  expect(normalizeQuery('span cart')).toBe('text=span cart');
  expect(normalizeQuery('cart')).toBe('text=cart');
});
