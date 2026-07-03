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
 * OpenAI-style `/models` — network error). Callers treat `null` as "don't
 * self-look": the separate-call path already fails soft (vision latch), while
 * an image pushed at a text-only DRIVER would poison every later step of the
 * run (the SDK re-sends tool results each turn).
 */

/** One models-catalog row, OpenRouter shape (other providers may omit `architecture`). */
interface CatalogModel {
  id: string;
  architecture?: { input_modalities?: string[] };
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
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const model = (data as CatalogModel[]).find((m) => m?.id === modelId);
  if (!model) return null;
  const modalities = model.architecture?.input_modalities;
  if (!Array.isArray(modalities)) return null; // catalog exists but says nothing (e.g. z.ai)
  return modalities.includes('image');
}
