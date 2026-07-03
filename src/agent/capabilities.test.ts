import { expect, test } from 'bun:test';
import { type FetchLike, supportsImageInput } from './capabilities.js';

/** A fake fetch returning a canned JSON body (or failing). */
function fakeFetch(body: unknown, ok = true): FetchLike {
  return async () => ({ ok, json: async () => body });
}

const CATALOG = {
  data: [
    { id: 'text-only/model', architecture: { input_modalities: ['text'] } },
    { id: 'multi/model', architecture: { input_modalities: ['text', 'image'] } },
    { id: 'no-arch/model' },
  ],
};

test('true when the catalog lists image among the model input modalities', async () => {
  expect(await supportsImageInput('https://x/api/v1', 'k', 'multi/model', fakeFetch(CATALOG))).toBe(
    true,
  );
});

test('false when the catalog says text-only', async () => {
  expect(
    await supportsImageInput('https://x/api/v1', 'k', 'text-only/model', fakeFetch(CATALOG)),
  ).toBe(false);
});

test('null when the catalog cannot answer (no architecture / unknown model / bad response)', async () => {
  // model listed but no architecture field (e.g. z.ai's OpenAI-style /models)
  expect(
    await supportsImageInput('https://x/api/v1', 'k', 'no-arch/model', fakeFetch(CATALOG)),
  ).toBeNull();
  // model absent from the catalog
  expect(
    await supportsImageInput('https://x/api/v1', 'k', 'missing', fakeFetch(CATALOG)),
  ).toBeNull();
  // non-OK response
  expect(
    await supportsImageInput('https://x/api/v1', 'k', 'multi/model', fakeFetch(CATALOG, false)),
  ).toBeNull();
  // malformed body
  expect(
    await supportsImageInput('https://x/api/v1', 'k', 'multi/model', fakeFetch({ nope: 1 })),
  ).toBeNull();
  // network failure
  const throwing: FetchLike = async () => {
    throw new Error('fetch failed');
  };
  expect(await supportsImageInput('https://x/api/v1', 'k', 'multi/model', throwing)).toBeNull();
});

test('sends the API key and hits <base>/models (trailing slash tolerated)', async () => {
  let seenUrl = '';
  let seenAuth = '';
  const spy: FetchLike = async (url, init) => {
    seenUrl = url;
    seenAuth = String(init?.headers?.Authorization);
    return { ok: true, json: async () => CATALOG };
  };
  await supportsImageInput('https://x/api/v1/', 'sk-123', 'multi/model', spy);
  expect(seenUrl).toBe('https://x/api/v1/models');
  expect(seenAuth).toBe('Bearer sk-123');
});
