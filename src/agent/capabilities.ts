/**
 * Model capability probe — can a model take image input?
 *
 * Decides whether `look` can hand the frame straight to the DRIVER (self-look:
 * same model for control + vision) instead of a second blind vision call. The
 * answer comes from the provider's `/models` catalog the way OpenRouter exposes
 * it: `data[].architecture.input_modalities` (e.g. `["text","image"]`).
 *
 * Three-valued on purpose: `true` / `false` when the catalog answers, `null`
 * when it can't (endpoint missing, no `architecture` field — e.g. z.ai's
 * OpenAI-style `/models` — network error, malformed payload). Callers treat
 * `null` as "don't self-look": the separate-call path already fails soft
 * (vision latch), while an image pushed at a text-only DRIVER would poison
 * every later step of the run (the SDK re-sends tool results each turn).
 */

import { z } from 'zod';

/** One models-catalog row, OpenRouter shape (other providers may omit `architecture`). */
const CatalogModelSchema = z.object({
  id: z.string(),
  architecture: z.object({ input_modalities: z.array(z.string()).optional() }).nullish(),
});

/**
 * `/models` payload. A row that doesn't parse degrades to `null` and is skipped
 * — one odd entry in a 300-model catalog must not blind the probe for every model.
 */
const CatalogSchema = z.object({
  data: z.array(CatalogModelSchema.nullable().catch(null)),
});

/**
 * Catalog id for a routing-suffixed model id. The router accepts suffixes the
 * `/models` catalog does not list as ids of their own — `#uptime` (the shipped
 * default driver, `config/load.ts`), `:nitro`, `:floor`. Some suffixed ids ARE
 * listed verbatim (`…:free`), so the probe tries the id as given first and only
 * then falls back to this base form.
 */
function baseModelId(modelId: string): string {
  const base = modelId.replace(/[#:].*$/, '');
  return base || modelId; // nothing but suffix — no base to fall back to
}

/**
 * The slice of `fetch` the probe needs — typed locally (the DOM lib is off
 * project-wide), satisfied by the global `fetch` and by test fakes alike.
 */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/**
 * Look the model up in the provider's `/models` catalog and report whether its
 * input modalities include `image`. `null` = the catalog can't say.
 */
export async function supportsImageInput(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  fetchImpl: FetchLike = fetch,
): Promise<boolean | null> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    return null; // catalog unreachable — not a run-blocking condition
  }
  if (!res.ok) return null;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const catalog = CatalogSchema.safeParse(body);
  if (!catalog.success) return null; // not a models catalog at all

  const rows = catalog.data.data;
  const base = baseModelId(modelId);
  const model =
    rows.find((row) => row?.id === modelId) ??
    (base === modelId ? undefined : rows.find((row) => row?.id === base));

  const modalities = model?.architecture?.input_modalities;
  if (!modalities) return null; // model unlisted, or catalog says nothing (e.g. z.ai)
  return modalities.includes('image');
}
