import { expect, test } from 'bun:test';
import {
  AdapterError,
  AgentError,
  ConfigError,
  ProviderError,
  SessionBusyError,
  SessionNotFoundError,
  TargetNotFoundError,
  UiDebuggerError,
} from './errors.js';

test('UiDebuggerError: message, name, instanceof', () => {
  const e = new UiDebuggerError('base');
  expect(e.message).toBe('base');
  expect(e.name).toBe('UiDebuggerError');
  expect(e instanceof UiDebuggerError).toBe(true);
  expect(e instanceof Error).toBe(true);
});

test('ConfigError: message, name, instanceof chain', () => {
  const e = new ConfigError('bad config');
  expect(e.message).toBe('bad config');
  expect(e.name).toBe('ConfigError');
  expect(e instanceof ConfigError).toBe(true);
  expect(e instanceof UiDebuggerError).toBe(true);
});

test('SessionBusyError: message, name, instanceof chain', () => {
  const e = new SessionBusyError('busy');
  expect(e.message).toBe('busy');
  expect(e.name).toBe('SessionBusyError');
  expect(e instanceof SessionBusyError).toBe(true);
  expect(e instanceof UiDebuggerError).toBe(true);
});

test('SessionNotFoundError: message, name, instanceof chain', () => {
  const e = new SessionNotFoundError('not found');
  expect(e.message).toBe('not found');
  expect(e.name).toBe('SessionNotFoundError');
  expect(e instanceof SessionNotFoundError).toBe(true);
  expect(e instanceof UiDebuggerError).toBe(true);
});

test('TargetNotFoundError: message, name, instanceof chain', () => {
  const e = new TargetNotFoundError('target missing');
  expect(e.message).toBe('target missing');
  expect(e.name).toBe('TargetNotFoundError');
  expect(e instanceof TargetNotFoundError).toBe(true);
  expect(e instanceof UiDebuggerError).toBe(true);
});

test('AdapterError: message, name, instanceof chain', () => {
  const e = new AdapterError('adapter failed');
  expect(e.message).toBe('adapter failed');
  expect(e.name).toBe('AdapterError');
  expect(e instanceof AdapterError).toBe(true);
  expect(e instanceof UiDebuggerError).toBe(true);
});

test('AgentError: message, name, instanceof chain', () => {
  const e = new AgentError('agent failed');
  expect(e.message).toBe('agent failed');
  expect(e.name).toBe('AgentError');
  expect(e instanceof AgentError).toBe(true);
  expect(e instanceof UiDebuggerError).toBe(true);
});

test('ProviderError: message, name, instanceof chain', () => {
  const e = new ProviderError('provider down');
  expect(e.message).toBe('provider down');
  expect(e.name).toBe('ProviderError');
  expect(e instanceof ProviderError).toBe(true);
  expect(e instanceof UiDebuggerError).toBe(true);
});

test('error classes do not cross-instanceof', () => {
  const cfg = new ConfigError('x');
  const sess = new SessionBusyError('x');
  expect(cfg instanceof SessionBusyError).toBe(false);
  expect(sess instanceof ConfigError).toBe(false);
});
