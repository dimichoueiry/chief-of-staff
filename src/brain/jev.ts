/**
 * Jev, TypeSafe's "System One" model. It doesn't write: given some state and typed questions (a
 * choice between labels we supply, or a yes/no) it answers each with a probability, in about a
 * tenth of a second. That makes it the right tool for deciding what a spoken command wants when
 * the answer is one of a known set, and the wrong one for anything that needs words.
 *
 * Only POST /v1/systemone, over fetch. The official SDK (@typesafe-ai/sdk) retries with a 10 s
 * timeout per try; a voice command that waits that long should have gone to the language model.
 * The key is TYPESAFE_API_KEY, read from ~/.cos/.env like every other key.
 */

export const JEV_KEY_ENV = "TYPESAFE_API_KEY";
const DEFAULT_BASE = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";
/** Past this, the language model would already be well on its way. */
export const JEV_TIMEOUT_MS = 1_500;

export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } };

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface NoulAnswer {
  type: "noul";
  /** Probability of yes, 0 to 1. */
  noul: number;
}

export interface JevRequest {
  state: unknown;
  questions: Record<string, JevQuestion>;
}

export interface JevResult {
  /** The model that answered, e.g. "jev-1.13.0". */
  model: string;
  answers: Record<string, ChoiceAnswer | NoulAnswer>;
}

export type Jev = (req: JevRequest) => Promise<JevResult>;

/** A Jev client when a key is set, otherwise null. */
export function jevFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Jev | null {
  const key = env[JEV_KEY_ENV]?.trim();
  if (!key) return null;
  const base = (env.TYPESAFE_BASE_URL?.trim() || DEFAULT_BASE).replace(/\/+$/, "");
  const model = env.TYPESAFE_DEFAULT_MODEL?.trim() || DEFAULT_MODEL;
  return async (req) => {
    const res = await fetchImpl(`${base}/v1/systemone`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, ...req }),
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const detail = body && typeof body === "object" ? String((body.error as { message?: string })?.message ?? body.error ?? body.detail ?? "") : "";
      throw new Error(`Jev answered ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    return readResult(body, req.questions);
  };
}

/** Reject malformed answers before they can authorize an action. */
function readResult(body: Record<string, unknown> | null, questions: JevRequest["questions"]): JevResult {
  const answers = body?.answers;
  if (!isRecord(answers)) throw new Error("Jev sent no answers");
  for (const [name, question] of Object.entries(questions)) {
    const a = answers[name];
    let ok = false;
    if (isRecord(a) && a.type === question.type) {
      if (question.type === "noul") {
        ok = probability(a.noul);
      } else if (typeof a.choice === "string" && Object.hasOwn(question.criteria, a.choice) && probability(a.confidence) && isRecord(a.probabilities)) {
        const probabilities = a.probabilities;
        const labels = Object.keys(question.criteria);
        ok = Object.keys(probabilities).length === labels.length &&
          labels.every((label) => Object.hasOwn(probabilities, label) && probability(probabilities[label]));
        if (ok) {
          const values = labels.map((label) => probabilities[label] as number);
          // Allow floating-point rounding, but never invent missing probability mass.
          ok = Math.abs(values.reduce((sum, p) => sum + p, 0) - 1) <= 0.001 &&
            (probabilities[a.choice] as number) >= Math.max(...values);
        }
      }
    }
    if (!ok) throw new Error(`Jev's answer to "${name}" isn't readable`);
  }
  return { model: typeof body!.model === "string" ? body!.model : DEFAULT_MODEL, answers: answers as unknown as JevResult["answers"] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
