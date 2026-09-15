/**
 * Reading a short spoken or typed answer to "should I do this?". Clear yes and
 * clear no are decided here, by rules; anything else ("yes, but change the
 * second line", "what does it say?") is left to the model, which may only act
 * on what the user said (see confirm_pending in tools.ts).
 */

export type Consent = "yes" | "no" | "unclear";

const YES = /\b(yes|yeah|yea|yep|yup|ya|sure|ok|okay|k|alright|all right|go|go ahead|do it|send|open|run|start|launch|confirm|confirmed|approve|approved|please do|go for it|sounds good|looks good|perfect|great|fine|good|cool|absolutely|of course|definitely|correct|exactly|right away|let'?s go|let'?s do it|ship it|proceed)\b/;
const NO = /\b(no|nope|nah|not|don'?t|do not|never|cancel|stop|wait|hold on|hold off|never ?mind|forget it|scrap that|skip it)\b/;
/** Words that mean "yes, but differently": the model should handle those. */
const CHANGE = /\b(but|instead|change|edit|rewrite|reword|different|other|another|also|first|before|except|actually|wrong|shorter|longer|add|remove|tell (it|them|her|him)|say|mention|replace|and then|then)\b/;

export function readConsent(text: string): Consent {
  const t = text.toLowerCase().replace(/[’`]/g, "'").replace(/[^\w\s']/g, " ").replace(/\s+/g, " ").trim();
  if (!t || text.includes("?")) return "unclear";
  if (t.split(" ").length > 14) return "unclear";
  // "don't send it" is a no, not a "send": take negated action words out before looking for a yes.
  const plain = t.replace(/\b(?:don'?t|do not|not|never|no)\s+(?:just\s+|even\s+|you\s+)?(?:send|open|run|start|do|go|launch)\b/g, " no ");
  const yes = YES.test(plain);
  const no = NO.test(plain);
  const change = CHANGE.test(plain);
  if (no && !yes && !change) return "no";
  if (yes && !no && !change) return "yes";
  return "unclear";
}
