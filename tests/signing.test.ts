import { describe, expect, it } from "vitest";
import { SIGNING_NAME, parseIdentity, parseRequirement } from "../src/cli/signing.js";

describe("the app's signing identity", () => {
  it("finds the local certificate in security's list, trusted or not", () => {
    const out = [
      "",
      "Policy: Code Signing",
      "  Matching identities",
      '  1) 1111111111111111111111111111111111111111 "Some Other Cert" (CSSMERR_TP_CERT_EXPIRED)',
      `  2) 82BB942633AAF6213B38A0807BA12A18AD84AA5B "${SIGNING_NAME}" (CSSMERR_TP_NOT_TRUSTED)`,
      "     2 identities found",
    ].join("\n");
    expect(parseIdentity(out)).toBe("82BB942633AAF6213B38A0807BA12A18AD84AA5B");
    expect(parseIdentity("     0 identities found")).toBeNull();
  });

  it("reads what macOS checks permissions against: the build's hash when ad-hoc, the certificate otherwise", () => {
    const cert = 'Executable=/x\ndesignated => identifier "com.chief-of-staff.menubar" and certificate leaf = H"82bb942633aaf6213b38a0807ba12a18ad84aa5b"\n';
    expect(parseRequirement(cert)).toBe('identifier "com.chief-of-staff.menubar" and certificate leaf = H"82bb942633aaf6213b38a0807ba12a18ad84aa5b"');
    expect(parseRequirement('designated => cdhash H"4f1c…"')).toBe('cdhash H"4f1c…"');
    expect(parseRequirement("code object is not signed at all")).toBeNull();
  });
});
