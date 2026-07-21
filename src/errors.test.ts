import { expect, test } from 'bun:test';
import {
  AdapterError,
  AdbError,
  AgentError,
  ConfigError,
  FindingsError,
  McpServerError,
  ProviderError,
  ReplayError,
  SessionBusyError,
  SessionNotFoundError,
  SessionSettledError,
  TargetNotFoundError,
  UiDebuggerError,
  VisionUnavailableError,
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

test('SessionSettledError: message, name, instanceof chain', () => {
  const e = new SessionSettledError('already settled');
  expect(e.message).toBe('already settled');
  expect(e.name).toBe('SessionSettledError');
  expect(e instanceof SessionSettledError).toBe(true);
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

test('FindingsError: message, name, instanceof chain', () => {
  const e = new FindingsError('findings invalid');
  expect(e.message).toBe('findings invalid');
  expect(e.name).toBe('FindingsError');
  expect(e instanceof FindingsError).toBe(true);
  expect(e instanceof UiDebuggerError).toBe(true);
});

test('McpServerError: message, name, instanceof chain', () => {
  const e = new McpServerError('duplicate tool');
  expect(e.message).toBe('duplicate tool');
  expect(e.name).toBe('McpServerError');
  expect(e instanceof McpServerError).toBe(true);
  expect(e instanceof UiDebuggerError).toBe(true);
});

test('ReplayError: message, name, instanceof chain', () => {
  const e = new ReplayError('ffmpeg failed');
  expect(e.message).toBe('ffmpeg failed');
  expect(e.name).toBe('ReplayError');
  expect(e instanceof ReplayError).toBe(true);
  expect(e instanceof UiDebuggerError).toBe(true);
});

test('AdbError: message, name, instanceof chain (extends AdapterError)', () => {
  const e = new AdbError('adb call failed');
  expect(e.message).toBe('adb call failed');
  expect(e.name).toBe('AdbError');
  expect(e instanceof AdbError).toBe(true);
  expect(e instanceof AdapterError).toBe(true);
  expect(e instanceof UiDebuggerError).toBe(true);
});

test('VisionUnavailableError: message, name, instanceof chain (extends AgentError)', () => {
  const e = new VisionUnavailableError('vision model is text-only');
  expect(e.message).toBe('vision model is text-only');
  expect(e.name).toBe('VisionUnavailableError');
  expect(e instanceof VisionUnavailableError).toBe(true);
  expect(e instanceof AgentError).toBe(true);
  expect(e instanceof UiDebuggerError).toBe(true);
});

test('error classes do not cross-instanceof', () => {
  const cfg = new ConfigError('x');
  const sess = new SessionBusyError('x');
  expect(cfg instanceof SessionBusyError).toBe(false);
  expect(sess instanceof ConfigError).toBe(false);
});

test('AdbError, McpServerError, ReplayError, VisionUnavailableError do not cross-instanceof', () => {
  const adb = new AdbError('x');
  const mcp = new McpServerError('x');
  const replay = new ReplayError('x');
  const vision = new VisionUnavailableError('x');
  expect(adb instanceof McpServerError).toBe(false);
  expect(adb instanceof AgentError).toBe(false);
  expect(mcp instanceof AdapterError).toBe(false);
  expect(replay instanceof McpServerError).toBe(false);
  expect(vision instanceof AdapterError).toBe(false);
  expect(vision instanceof AdbError).toBe(false);
});
