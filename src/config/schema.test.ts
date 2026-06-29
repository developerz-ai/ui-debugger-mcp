import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  ConfigSchema,
  DesktopTargetSchema,
  ModelsSchema,
  TargetSchema,
  WebTargetSchema,
} from './schema.js';

const example = JSON.parse(
  readFileSync(new URL('../../.ui-debugger-mcp.example.json', import.meta.url), 'utf8'),
);

test('accepts the example config verbatim', () => {
  const parsed = ConfigSchema.parse(example);
  expect(parsed.targets.web?.adapter).toBe('browser');
  expect(parsed.models?.driver).toBe('deepseek/deepseek-v4-flash#uptime');
  expect(parsed.workspace).toBe('./tmp/ui-debugger-mcp');
});

test('ModelsSchema: summary is optional, driver and vision required', () => {
  expect(ModelsSchema.safeParse({ driver: 'a', vision: 'b' }).success).toBe(true);
  expect(ModelsSchema.safeParse({ driver: 'a' }).success).toBe(false);
});

test('WebTargetSchema: requires a valid url and the browser adapter literal', () => {
  const base = { adapter: 'browser', url: 'http://localhost:3000', headless: true };
  expect(WebTargetSchema.safeParse(base).success).toBe(true);
  expect(WebTargetSchema.safeParse({ ...base, url: 'not-a-url' }).success).toBe(false);
  expect(WebTargetSchema.safeParse({ ...base, adapter: 'desktop' }).success).toBe(false);
});

test('WebTargetSchema: executablePath and cdpUrl accept null', () => {
  const parsed = WebTargetSchema.parse({
    adapter: 'browser',
    url: 'http://localhost:3000',
    headless: false,
    executablePath: null,
    cdpUrl: null,
  });
  expect(parsed.executablePath).toBeNull();
  expect(parsed.cdpUrl).toBeNull();
});

test('DesktopTargetSchema: launch required; window match and display optional', () => {
  const base = { adapter: 'desktop', launch: 'my-app' };
  expect(DesktopTargetSchema.safeParse(base).success).toBe(true); // minimal still valid
  expect(DesktopTargetSchema.safeParse({ adapter: 'desktop' }).success).toBe(false); // launch required

  const parsed = DesktopTargetSchema.parse({
    ...base,
    window: { title: 'My App', class: 'my-app' },
    display: ':99',
  });
  expect(parsed.window?.title).toBe('My App');
  expect(parsed.display).toBe(':99');
});

test('DesktopTargetSchema: display accepts null, strict rejects unknown keys', () => {
  expect(
    DesktopTargetSchema.safeParse({ adapter: 'desktop', launch: 'a', display: null }).success,
  ).toBe(true);
  expect(
    DesktopTargetSchema.safeParse({ adapter: 'desktop', launch: 'a', window: { role: 'x' } })
      .success,
  ).toBe(false); // window match is strict too
  expect(DesktopTargetSchema.safeParse({ adapter: 'desktop', launch: 'a', bogus: 1 }).success).toBe(
    false,
  );
});

test('TargetSchema: discriminates desktop and android, rejects unknown adapters', () => {
  expect(TargetSchema.safeParse({ adapter: 'desktop', launch: 'app' }).success).toBe(true);
  expect(TargetSchema.safeParse({ adapter: 'android', avd: 'my-avd' }).success).toBe(true);
  expect(TargetSchema.safeParse({ adapter: 'ios', url: 'http://x.test' }).success).toBe(false);
});

test('ConfigSchema: models and workspace optional, targets required', () => {
  const minimal = {
    targets: { web: { adapter: 'browser', url: 'http://x.test', headless: true } },
  };
  expect(ConfigSchema.safeParse(minimal).success).toBe(true);
  expect(ConfigSchema.safeParse({ models: { driver: 'a', vision: 'b' } }).success).toBe(false);
});
