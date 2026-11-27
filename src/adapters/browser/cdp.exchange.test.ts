/**
 * `CdpCapture` payload capture — what an exchange's bodies become on the way in:
 * binary and oversized bodies as markers, credential-keyed values redacted, and
 * requests still in flight read back as `pending` rows. Fakes shared with
 * `cdp.test.ts` via `cdp.test-helpers.ts`.
 */

import { expect, test } from 'bun:test';
import { BODY_CAP, BODY_READ_MAX_BYTES } from './cdp.js';
import { fakeFailed, fakeResponse, flush, setup } from './cdp.test-helpers.js';

test('a binary or oversized API body is never read — a marker says why, text stays captured', async () => {
  const { page, cap } = setup();
  const bodyOf = async (responseHeaders: Record<string, string>) => {
    let reads = 0;
    const response = fakeResponse({
      url: 'http://x/api/file',
      status: 200,
      ok: true,
      body: '\u0000PNG garbage',
      responseHeaders,
    });
    page.emit('response', {
      ...response,
      text: async () => {
        reads += 1;
        return response.text();
      },
    });
    await flush();
    return { body: cap.network({ limit: 1 })[0]?.responseBody, reads };
  };
  expect(await bodyOf({ 'content-type': 'image/png' })).toEqual({
    body: '<binary body, image/png>',
    reads: 0,
  });
  expect(await bodyOf({ 'content-type': 'application/octet-stream' })).toEqual({
    body: '<binary body, application/octet-stream>',
    reads: 0,
  });
  expect(
    await bodyOf({
      'content-type': 'application/json',
      'content-length': String(BODY_READ_MAX_BYTES + 1),
    }),
  ).toEqual({ body: `<body not read, ${BODY_READ_MAX_BYTES + 1} bytes>`, reads: 0 });
  // JSON-API vendor types are text — still read.
  expect(await bodyOf({ 'content-type': 'application/vnd.api+json' })).toEqual({
    body: '\u0000PNG garbage',
    reads: 1,
  });
});

// --- in-flight requests ---------------------------------------------------------

test('a request still in flight reads back as a pending row, timed so far — until it settles', async () => {
  let clock = 1000;
  const { page, cap } = setup({ now: () => clock });
  const hung = fakeResponse({
    method: 'POST',
    url: 'http://x/api/save?token=abc',
    status: 200,
    ok: true,
    postData: '{"name":"a"}',
    body: '{}',
  });
  page.emit('request', hung.request());
  clock = 4000;

  const [row] = cap.network();
  expect(row).toEqual({
    method: 'POST',
    url: 'http://x/api/save?token=<redacted, 3 chars>',
    status: 0,
    ok: false,
    pending: true,
    resourceType: 'fetch',
    timestamp: 1000,
    tab: 'tab-1',
    durationMs: 3000,
    requestBody: '{"name":"a"}',
  });
  // Pending is not failed, and it is filterable on its own.
  expect(cap.network({ filters: { failed_eq: true } })).toEqual([]);
  expect(cap.network({ filters: { pending_eq: true } })).toHaveLength(1);

  page.emit('response', hung);
  await flush();
  const settled = cap.network();
  expect(settled).toHaveLength(1);
  expect(settled[0]?.pending).toBeUndefined();
  expect(settled[0]?.status).toBe(200);
  expect(cap.network({ filters: { pending_eq: true } })).toEqual([]);
});

test('a failed request leaves the in-flight set; stop() releases it, and the set is capped', () => {
  const { page, cap } = setup({ cap: 2 });
  const requestOf = (url: string) => fakeResponse({ url, status: 200, ok: true }).request();
  const failed = {
    ...requestOf('http://x/api/f'),
    failure: () => ({ errorText: 'net::ERR_FAILED' }),
  };
  page.emit('request', failed);
  page.emit('requestfailed', failed);
  expect(cap.network({ filters: { pending_eq: true } })).toEqual([]);

  for (const n of [1, 2, 3]) page.emit('request', requestOf(`http://x/api/${n}`));
  // Ring-capped like every buffer: the oldest in-flight request is dropped.
  expect(cap.network({ filters: { pending_eq: true } }).map((e) => e.url)).toEqual([
    'http://x/api/3',
    'http://x/api/2',
  ]);
  // A page we no longer watch can never settle a request — never report it forever.
  cap.stop();
  expect(cap.network({ filters: { pending_eq: true } })).toEqual([]);
});

// --- credential-keyed body values --------------------------------------------------

test('a login body and its token response never reach the buffer with their secrets', async () => {
  const { page, cap } = setup();
  page.emit(
    'response',
    fakeResponse({
      method: 'POST',
      url: 'http://x/api/login',
      status: 200,
      ok: true,
      postData: '{"email":"a@b.c","password":"hunter2"}',
      body: '{"user":{"id":1},"accessToken":"eyJabc","refresh_token":"r1"}',
    }),
  );
  await flush();
  const [entry] = cap.network();
  expect(entry?.requestBody).toBe('{"email":"a@b.c","password":"<redacted, 7 chars>"}');
  expect(entry?.responseBody).toBe(
    '{"user":{"id":1},"accessToken":"<redacted, 6 chars>","refresh_token":"<redacted, 2 chars>"}',
  );
});

test('a detached frame or a closed tab takes its in-flight requests with it', () => {
  const { page, cap } = setup();
  const frameA = { name: 'a' };
  const frameB = { name: 'b' };
  const requestIn = (url: string, frame: () => unknown) => ({
    ...fakeResponse({ url, status: 200, ok: true }).request(),
    frame,
  });
  const pendingUrls = () => cap.network({ filters: { pending_eq: true } }).map((e) => e.url);
  page.emit(
    'request',
    requestIn('http://x/api/in-a', () => frameA),
  );
  page.emit(
    'request',
    requestIn('http://x/api/in-b', () => frameB),
  );
  page.emit(
    'request',
    requestIn('http://x/api/worker', () => {
      throw new Error('Service Worker requests do not have an associated frame.');
    }),
  );

  page.emit('framedetached', frameA);
  expect(pendingUrls()).toEqual(['http://x/api/worker', 'http://x/api/in-b']);
  page.emit('close', undefined);
  expect(pendingUrls()).toEqual([]);
});

test('a pending upload is sanitized ONCE, and an oversized one is a size marker, never raw', () => {
  const { page, cap } = setup();
  let postDataReads = 0;
  const big = 'x'.repeat(BODY_READ_MAX_BYTES + 1);
  const upload = (url: string, data: string) => ({
    ...fakeResponse({ url, status: 200, ok: true }).request(),
    postData: () => {
      postDataReads += 1;
      return data;
    },
  });
  page.emit('request', upload('http://x/api/small', '{"password":"pw"}'));
  const bigBody = `{"password":"pw","blob":"${big}"}`;
  page.emit('request', upload('http://x/api/big', bigBody));
  for (let i = 0; i < 5; i += 1) cap.network();

  expect(postDataReads).toBe(2); // once per request, not once per read
  const byUrl = Object.fromEntries(cap.network().map((e) => [e.url, e.requestBody]));
  expect(byUrl['http://x/api/small']).toBe('{"password":"<redacted, 2 chars>"}');
  expect(byUrl['http://x/api/big']).toBe(`<body not read, ${bigBody.length} chars>`);
});

test('a chunked text body (no Content-Length) is read, but only BODY_CAP of it is retained', async () => {
  const { page, cap } = setup();
  const huge = 'a'.repeat(BODY_READ_MAX_BYTES * 2);
  page.emit(
    'response',
    fakeResponse({
      url: 'http://x/api/export',
      status: 500,
      ok: false,
      body: huge,
      responseHeaders: { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' },
    }),
  );
  await flush();
  const body = cap.network()[0]?.responseBody ?? '';
  expect(body.length).toBeLessThan(BODY_CAP + 64);
  expect(body).toEndWith(`[truncated, ${huge.length} chars total]`);
});

test('a credential-bearing URL never reaches the buffer or the log verbatim', async () => {
  const lines: string[] = [];
  const { page, cap } = setup({ sink: (_ch, line) => lines.push(line) });
  const url = 'https://app/oauth?access_token=ya29.SECRET';
  page.emit('response', fakeResponse({ url, status: 200, ok: true, body: '{}' }));
  page.emit(
    'requestfailed',
    fakeFailed({ url: 'https://app/reset?token=SECRET2', errorText: 'net::ERR_FAILED' }),
  );
  await flush();
  const urls = cap.network().map((e) => e.url);
  expect(urls.some((u) => u.includes('ya29.SECRET'))).toBe(false);
  expect(urls.some((u) => u.includes('SECRET2'))).toBe(false);
  expect(urls).toContain('https://app/oauth?access_token=<redacted, 11 chars>');
  expect(lines.some((l) => l.includes('SECRET'))).toBe(false);
});
