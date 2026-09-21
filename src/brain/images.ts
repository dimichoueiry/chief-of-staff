/**
 * Making pictures, through OpenRouter's images endpoint (POST /api/v1/images).
 *
 * It is not the chat endpoint and not an adapter in llm/: a picture is one request with a
 * prompt and, when a picture is being changed rather than made, the picture it came from.
 * Every image model on OpenRouter takes the same shape, so which one is in use is only a
 * name (see the image model in llm/registry.ts).
 *
 * The bytes come back base64 inside JSON, so nothing is fetched from anywhere else.
 */
const IMAGES_URL = "https://openrouter.ai/api/v1/images";
const MODELS_URL = "https://openrouter.ai/api/v1/images/models";

/** Drawing takes its time; a pro model on a busy day is well over a minute. */
const TIMEOUT_MS = 180_000;
const MODELS_TIMEOUT_MS = 15_000;

export interface ImageReference {
  /** base64, no data: prefix. */
  data: string;
  mediaType: string;
}

export interface ImageRequest {
  prompt: string;
  /** The model id as OpenRouter writes it, e.g. google/gemini-3.1-flash-image. */
  model: string;
  /** "1:1", "4:5", "16:9"… Left out means whatever the model does by default. */
  aspectRatio?: string;
  /** Pictures to work from: the one being changed, a logo, a photo of them. */
  references?: ImageReference[];
}

export interface MadeImage {
  data: Buffer;
  mediaType: string;
}

/** Replaced in tests, and the seam anything other than OpenRouter would come in through. */
export type ImageMaker = (r: ImageRequest, env?: NodeJS.ProcessEnv) => Promise<MadeImage>;

export interface ImageModel {
  id: string;
  name: string;
}

function key(env: NodeJS.ProcessEnv): string {
  const k = env.OPENROUTER_API_KEY;
  if (!k) throw new Error("Making pictures needs an OpenRouter key. Add OPENROUTER_API_KEY under ✦ › API keys.");
  return k;
}

const headers = (env: NodeJS.ProcessEnv) => ({
  authorization: `Bearer ${key(env)}`,
  "content-type": "application/json",
  "X-OpenRouter-Title": "Chief of Staff",
});

/** What OpenRouter said went wrong, in one line, or the status when it said nothing useful. */
async function explain(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    const message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
    if (message) return message;
  } catch {
    /* not JSON: the status and whatever text there was say more than nothing */
  }
  return `${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`;
}

/** The format from the bytes themselves: the response says which model drew it, not what it drew it as. */
function sniff(data: Buffer): string {
  if (data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length > 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  throw new Error("The model sent back something that isn't an image.");
}

interface ImagesResponse {
  data?: { b64_json?: string; url?: string }[];
}

export const openRouterImages: ImageMaker = async (r, env: NodeJS.ProcessEnv = process.env) => {
  const prompt = r.prompt.trim();
  if (!prompt) throw new Error("An image needs a prompt: say what should be in it.");
  const res = await fetch(IMAGES_URL, {
    method: "POST",
    headers: headers(env),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model: r.model,
      prompt,
      ...(r.aspectRatio ? { aspect_ratio: r.aspectRatio } : {}),
      ...(r.references?.length
        ? { input_references: r.references.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mediaType};base64,${i.data}` } })) }
        : {}),
    }),
  });
  if (!res.ok) throw new Error(`${r.model} couldn't draw it: ${await explain(res)}`);
  const body = (await res.json()) as ImagesResponse;
  const first = body.data?.[0];
  const b64 = first?.b64_json ?? (first?.url?.startsWith("data:") ? first.url.slice(first.url.indexOf(",") + 1) : undefined);
  if (!b64) throw new Error(`${r.model} answered without an image. Try another image model.`);
  const data = Buffer.from(b64, "base64");
  return { data, mediaType: sniff(data) };
};

/** Every model on OpenRouter that draws, for the picker. */
export async function imageModels(env: NodeJS.ProcessEnv = process.env): Promise<ImageModel[]> {
  const res = await fetch(MODELS_URL, { headers: headers(env), signal: AbortSignal.timeout(MODELS_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`OpenRouter didn't list its image models: ${await explain(res)}`);
  const body = (await res.json()) as { data?: { id?: string; name?: string }[] };
  return (body.data ?? [])
    .filter((m): m is { id: string; name?: string } => Boolean(m.id))
    .map((m) => ({ id: m.id, name: m.name ?? m.id }));
}
