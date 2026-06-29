/**
 * Custom error classes for UI Debugger MCP.
 * Each error type extends the base UiDebuggerError for proper error handling and recovery.
 */

export class UiDebuggerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UiDebuggerError';
    Object.setPrototypeOf(this, UiDebuggerError.prototype);
  }
}

export class ConfigError extends UiDebuggerError {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
    Object.setPrototypeOf(this, ConfigError.prototype);
  }
}

export class SessionBusyError extends UiDebuggerError {
  constructor(message: string) {
    super(message);
    this.name = 'SessionBusyError';
    Object.setPrototypeOf(this, SessionBusyError.prototype);
  }
}

export class SessionNotFoundError extends UiDebuggerError {
  constructor(message: string) {
    super(message);
    this.name = 'SessionNotFoundError';
    Object.setPrototypeOf(this, SessionNotFoundError.prototype);
  }
}

export class TargetNotFoundError extends UiDebuggerError {
  constructor(message: string) {
    super(message);
    this.name = 'TargetNotFoundError';
    Object.setPrototypeOf(this, TargetNotFoundError.prototype);
  }
}

export class AdapterError extends UiDebuggerError {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterError';
    Object.setPrototypeOf(this, AdapterError.prototype);
  }
}

/** A failed ADB invocation (android transport). Extends {@link AdapterError} so the agent loop catches it. */
export class AdbError extends AdapterError {
  constructor(message: string) {
    super(message);
    this.name = 'AdbError';
    Object.setPrototypeOf(this, AdbError.prototype);
  }
}

export class AgentError extends UiDebuggerError {
  constructor(message: string) {
    super(message);
    this.name = 'AgentError';
    Object.setPrototypeOf(this, AgentError.prototype);
  }
}

export class ProviderError extends UiDebuggerError {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
    Object.setPrototypeOf(this, ProviderError.prototype);
  }
}

export class FindingsError extends UiDebuggerError {
  constructor(message: string) {
    super(message);
    this.name = 'FindingsError';
    Object.setPrototypeOf(this, FindingsError.prototype);
  }
}

export class McpServerError extends UiDebuggerError {
  constructor(message: string) {
    super(message);
    this.name = 'McpServerError';
    Object.setPrototypeOf(this, McpServerError.prototype);
  }
}

export class ReplayError extends UiDebuggerError {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayError';
    Object.setPrototypeOf(this, ReplayError.prototype);
  }
}
