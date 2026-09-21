import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { imageModels, openRouterImages } from "../src/brain/images.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const env = { OPENROUTER_API_KEY: "sk-or-test" } as NodeJS.ProcessEnv;

interface Sent {
  url: string;
  body: Record<string, unknown>;
  auth: string;
}

describe("drawing through OpenRouter", () => {
  let sent: Sent[];
  let answer: () => Response;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    sent = [];
    answer = () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }), { status: 200 });
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      sent.push({
        url: String(url),
        body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
        auth: String((init.headers as Record<string, string>)?.authorization ?? ""),
      });
      return answer();
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("asks for one picture and reads the format off the bytes", async () => {
    const made = await openRouterImages({ prompt: "a lemon on a table", model: "google/gemini-3.1-flash-image", aspectRatio: "4:5" }, env);
    expect(made).toEqual({ data: PNG, mediaType: "image/png" });
    expect(sent[0].url).toBe("https://openrouter.ai/api/v1/images");
    expect(sent[0].auth).toBe("Bearer sk-or-test");
    expect(sent[0].body).toEqual({ model: "google/gemini-3.1-flash-image", prompt: "a lemon on a table", aspect_ratio: "4:5" });
  });

  it("sends the picture being changed with the change", async () => {
    await openRouterImages(
      { prompt: "make the lemon green", model: "m", references: [{ data: PNG.toString("base64"), mediaType: "image/png" }] },
      env,
    );
    expect(sent[0].body.input_references).toEqual([
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } },
    ]);
    expect(sent[0].body.aspect_ratio).toBeUndefined();
  });

  it("says what went wrong in words", async () => {
    await expect(openRouterImages({ prompt: "x", model: "m" }, {})).rejects.toThrow(/OPENROUTER_API_KEY/);
    expect(sent).toHaveLength(0);
    await expect(openRouterImages({ prompt: "  ", model: "m" }, env)).rejects.toThrow(/needs a prompt/);

    answer = () => new Response(JSON.stringify({ error: { message: "No endpoints found for m." } }), { status: 404 });
    await expect(openRouterImages({ prompt: "x", model: "m" }, env)).rejects.toThrow(/m couldn't draw it: No endpoints found/);

    answer = () => new Response(JSON.stringify({ data: [] }), { status: 200 });
    await expect(openRouterImages({ prompt: "x", model: "m" }, env)).rejects.toThrow(/answered without an image/);

    answer = () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("not a picture").toString("base64") }] }), { status: 200 });
    await expect(openRouterImages({ prompt: "x", model: "m" }, env)).rejects.toThrow(/isn't an image/);
  });

  it("lists the models that draw", async () => {
    answer = () => new Response(JSON.stringify({ data: [{ id: "google/gemini-3.1-flash-image", name: "Nano Banana 2" }, { id: "openai/gpt-image-2" }] }), { status: 200 });
    expect(await imageModels(env)).toEqual([
      { id: "google/gemini-3.1-flash-image", name: "Nano Banana 2" },
      { id: "openai/gpt-image-2", name: "openai/gpt-image-2" },
    ]);
    expect(sent[0].url).toBe("https://openrouter.ai/api/v1/images/models");
  });
});
