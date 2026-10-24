import { expect, test } from 'bun:test';
import { ProviderError } from '../errors.js';
import {
  createOpenRouterProvider,
  PROVIDER_API_KEY_ENV_VARS,
  providerApiKeyGuidance,
  resolveProviderApiKey,
  resolveProviderConfig,
} from './provider.js';

/**
 * Run `fn` with the provider credential env vars replaced by `values`
 * (unset = absent). The originals are restored afterwards, so a test can never
 * leak a key into the next one.
 */
function withEnv<T>(values: Record<string, string | undefined>, fn: () => T): T {
  const originals = new Map<string, string | undefined>();
  for (const name of PROVIDER_API_KEY_ENV_VARS) {
    originals.set(name, process.env[name]);
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of originals) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/**
 * Assert `actual` IS `expected` without letting a failure print the credential
 * value: a failing `toBe` would echo both operands into the test output.
 */
function expectSameSecret(actual: string, expected: string): void {
  expect(actual.length).toBe(expected.length);
  expect(actual === expected).toBe(true);
}

/**
 * A credential-shaped SENTINEL — a fake value that MUST never reach a message.
 * Deliberately shaped like a real key so the shape assertions below can fail.
 */
const CREDENTIAL_SENTINEL = 'sk-ant-sentinel-0123456789abcdef';

/** Matches a credential-shaped token (the `sk-`/`rk-`/`or-`/`pk-` key families). */
const CREDENTIAL_SHAPED = /\b(?:sk|rk|or|pk)-[A-Za-z0-9_-]{8,}\b/;

/**
 * Assert `message` carries NO credential-shaped token. Reports a boolean, not
 * the message, so a failing assertion never echoes a credential value.
 */
function expectNoCredentialShapedToken(message: string): void {
  expect(CREDENTIAL_SHAPED.test(message)).toBe(false);
}

test('createOpenRouterProvider: throws ProviderError when no API key is available', () => {
  withEnv({}, () => {
    expect(() => createOpenRouterProvider()).toThrow(ProviderError);
  });
});

test('createOpenRouterProvider: throws ProviderError when API key is empty string', () => {
  withEnv({}, () => {
    expect(() => createOpenRouterProvider({ apiKey: '   ' })).toThrow(ProviderError);
  });
});

test('createOpenRouterProvider: uses provided apiKey', () => {
  withEnv({}, () => {
    // Should not throw with a provided apiKey
    const provider = createOpenRouterProvider({ apiKey: 'test-key' });
    expect(provider).toBeDefined();
  });
});

test('createOpenRouterProvider: uses OPENAI_API_KEY fallback', () => {
  withEnv({ OPENAI_API_KEY: 'openai-key' }, () => {
    const provider = createOpenRouterProvider();
    expect(provider).toBeDefined();
  });
});

test('createOpenRouterProvider: uses OPENROUTER_API_KEY fallback', () => {
  withEnv({ OPENROUTER_API_KEY: 'openrouter-key' }, () => {
    const provider = createOpenRouterProvider();
    expect(provider).toBeDefined();
  });
});

test('createOpenRouterProvider: prefers provided apiKey over env vars', () => {
  withEnv({ OPENAI_API_KEY: 'env-openai-key', OPENROUTER_API_KEY: 'env-openrouter-key' }, () => {
    // Should not throw and should use the provided key
    const provider = createOpenRouterProvider({ apiKey: 'provided-key' });
    expect(provider).toBeDefined();
  });
});

test('createOpenRouterProvider: uses provided baseURL', () => {
  const originalBaseURL = process.env.OPENAI_BASE_URL;
  try {
    withEnv({ OPENAI_API_KEY: 'test-key' }, () => {
      delete process.env.OPENAI_BASE_URL;
      const provider = createOpenRouterProvider({ baseURL: 'https://custom.api/v1' });
      expect(provider).toBeDefined();
    });
  } finally {
    if (originalBaseURL) process.env.OPENAI_BASE_URL = originalBaseURL;
  }
});

test('createOpenRouterProvider: uses OPENAI_BASE_URL env var fallback', () => {
  const originalBaseURL = process.env.OPENAI_BASE_URL;
  try {
    withEnv({ OPENAI_API_KEY: 'test-key' }, () => {
      delete process.env.OPENAI_BASE_URL;
      process.env.OPENAI_BASE_URL = 'https://env-base-url/v1';
      const provider = createOpenRouterProvider();
      expect(provider).toBeDefined();
    });
  } finally {
    delete process.env.OPENAI_BASE_URL;
    if (originalBaseURL) process.env.OPENAI_BASE_URL = originalBaseURL;
  }
});

// --- the provider credential contract: explicit → OPENAI_API_KEY →
// OPENROUTER_API_KEY. Both entry points (runtime provider, boot-time config
// loader) resolve through it, so the precedence is pinned here.

test('resolveProviderApiKey: neither env key set resolves to undefined', () => {
  withEnv({}, () => {
    expect(resolveProviderApiKey()).toBeUndefined();
  });
});

test('resolveProviderApiKey: OPENAI_API_KEY alone resolves to that key', () => {
  withEnv({ OPENAI_API_KEY: 'openai-key' }, () => {
    const resolved = resolveProviderApiKey();
    expect(resolved).toBeDefined();
    expectSameSecret(resolved as string, 'openai-key');
  });
});

test('resolveProviderApiKey: OPENROUTER_API_KEY alone resolves to that key', () => {
  withEnv({ OPENROUTER_API_KEY: 'openrouter-key' }, () => {
    const resolved = resolveProviderApiKey();
    expect(resolved).toBeDefined();
    expectSameSecret(resolved as string, 'openrouter-key');
  });
});

test('resolveProviderApiKey: OPENAI_API_KEY wins when both env keys are set', () => {
  withEnv({ OPENAI_API_KEY: 'openai-key', OPENROUTER_API_KEY: 'openrouter-key' }, () => {
    const resolved = resolveProviderApiKey();
    expect(resolved).toBeDefined();
    expectSameSecret(resolved as string, 'openai-key');
  });
});

test('resolveProviderApiKey: an explicit apiKey wins over both env keys', () => {
  withEnv({ OPENAI_API_KEY: 'openai-key', OPENROUTER_API_KEY: 'openrouter-key' }, () => {
    const resolved = resolveProviderApiKey('explicit-key');
    expect(resolved).toBeDefined();
    expectSameSecret(resolved as string, 'explicit-key');
  });
});

test('resolveProviderApiKey: a blank env key falls through to the next source', () => {
  withEnv({ OPENAI_API_KEY: '   ', OPENROUTER_API_KEY: 'openrouter-key' }, () => {
    const resolved = resolveProviderApiKey();
    expect(resolved).toBeDefined();
    expectSameSecret(resolved as string, 'openrouter-key');
  });
});

test('resolveProviderConfig: resolves the OPENAI_API_KEY key when both are set', () => {
  withEnv({ OPENAI_API_KEY: 'openai-key', OPENROUTER_API_KEY: 'openrouter-key' }, () => {
    const { apiKey } = resolveProviderConfig();
    expectSameSecret(apiKey, 'openai-key');
  });
});

test('resolveProviderConfig: resolves the OPENROUTER_API_KEY key when it is the only one', () => {
  withEnv({ OPENROUTER_API_KEY: 'openrouter-key' }, () => {
    const { apiKey } = resolveProviderConfig();
    expectSameSecret(apiKey, 'openrouter-key');
  });
});

test('providerApiKeyGuidance: names every accepted env key and no other one', () => {
  const guidance = providerApiKeyGuidance();
  for (const name of PROVIDER_API_KEY_ENV_VARS) {
    expect(guidance).toContain(name);
  }
  // The guidance must not point at a variable the resolver never reads.
  expect(guidance).not.toContain('ANTHROPIC_API_KEY');
  expect(guidance).not.toContain('API_KEY=');
});

test('providerApiKeyGuidance: states the env precedence the resolver applies', () => {
  const guidance = providerApiKeyGuidance();
  // The accepted keys appear in RESOLUTION order — OPENAI_API_KEY first.
  expect(guidance.indexOf('OPENAI_API_KEY')).toBeLessThan(guidance.indexOf('OPENROUTER_API_KEY'));
  // The tie-break is stated explicitly and names the winning key.
  expect(guidance).toContain('OPENAI_API_KEY wins if both are set');
});

test('providerApiKeyGuidance: identical with and without a credential in the env', () => {
  const withoutCredential = providerApiKeyGuidance();
  withEnv({ OPENAI_API_KEY: CREDENTIAL_SENTINEL, OPENROUTER_API_KEY: CREDENTIAL_SENTINEL }, () => {
    // The guidance is env-independent: a credential sitting in process.env
    // must not change it. Compared as a boolean so a failure never echoes
    // the message (and with it a credential value).
    expect(providerApiKeyGuidance() === withoutCredential).toBe(true);
    expectNoCredentialShapedToken(providerApiKeyGuidance());
  });
  expectNoCredentialShapedToken(withoutCredential);
});

test('ProviderError message carries no credential value', () => {
  // A credential-shaped value sits in an env var the resolver never reads, so
  // the missing-key path still throws — the message must not pick it up.
  const original = process.env.ANTHROPIC_API_KEY;
  try {
    process.env.ANTHROPIC_API_KEY = CREDENTIAL_SENTINEL;
    withEnv({}, () => {
      let message = '';
      try {
        createOpenRouterProvider();
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toContain('OPENAI_API_KEY');
      expect(message).toContain('OPENROUTER_API_KEY');
      expectNoCredentialShapedToken(message);
    });
  } finally {
    if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = original;
  }
});
