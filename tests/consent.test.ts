import { describe, expect, it } from "vitest";
import { readConsent } from "../src/actions/consent.js";

describe("reading a yes or a no", () => {
  it("hears a yes the way people actually say it, including from real conversations", () => {
    for (const s of ["Yeah, you can send that", "Open it, just open it for me", "Send it", "yes", "go ahead", "Sure, send it to MLG", "that's fine", "yeah just send it", "ok", "perfect thanks", "Yep, run it."]) {
      expect([s, readConsent(s)]).toEqual([s, "yes"]);
    }
  });

  it("hears a no, including a negated action word", () => {
    for (const s of ["No", "nope", "no don't send it", "don't do it", "wait", "not now", "cancel that", "never mind"]) {
      expect([s, readConsent(s)]).toEqual([s, "no"]);
    }
  });

  it("leaves anything that changes the request, asks something, or mixes yes and no to the model", () => {
    for (const s of ["yes but change the second line", "what does it say?", "no, send it to the other agent", "ok and also tell it to update section 2", "don't wait, send it", "actually make it shorter", "Right what else do I have? That is important", ""]) {
      expect([s, readConsent(s)]).toEqual([s, "unclear"]);
    }
  });
});
