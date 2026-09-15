/**
 * A signing identity of the app's own, so macOS keeps its permissions across rebuilds.
 *
 * macOS ties Accessibility, Microphone, Screen Recording and the rest to the app's "designated
 * requirement". Ad-hoc signed, that requirement is the build's hash, so every rebuild lost them.
 * Signed with a certificate, it's the certificate, which stays the same from build to build.
 *
 * The certificate is self-signed and local: made once with openssl, kept in a keychain file of its
 * own (~/.cos/signing, not the login keychain, and never added to the keychain search list) whose
 * password is a random one saved beside it (owner-only), so builds sign without a password prompt.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { cosHome } from "../util/home.js";

const exec = promisify(execFile);

export const SIGNING_NAME = "Chief of Staff Local Signing";

export function signingDir(): string {
  return join(cosHome(), "signing");
}

export interface SigningIdentity {
  keychain: string;
  /** The certificate's SHA-1, which codesign takes as the identity. */
  sha1: string;
}

/** The SHA-1 of the named identity in `security find-identity` output, trusted or not. */
export function parseIdentity(output: string, name = SIGNING_NAME): string | null {
  for (const line of output.split("\n")) {
    const m = /^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/.exec(line);
    if (m && m[2] === name) return m[1];
  }
  return null;
}

/** The designated requirement line from `codesign -d -r-`, or null when unsigned. */
export function parseRequirement(output: string): string | null {
  return /designated => (.+)/.exec(output)?.[1].trim() ?? null;
}

async function unlock(keychain: string, dir: string): Promise<void> {
  const password = (await readFile(join(dir, "keychain-password"), "utf8")).trim();
  await exec("security", ["unlock-keychain", "-p", password, keychain]);
}

async function findIn(keychain: string): Promise<string | null> {
  const { stdout } = await exec("security", ["find-identity", "-p", "codesigning", keychain]);
  return parseIdentity(stdout);
}

/** The app's signing identity, made the first time it's needed. */
export async function ensureSigningIdentity(log: (line: string) => void = () => {}, dir = signingDir()): Promise<SigningIdentity> {
  const keychain = join(dir, "cos-signing.keychain-db");
  if (existsSync(keychain)) {
    await unlock(keychain, dir);
    const sha1 = await findIn(keychain);
    if (sha1) return { keychain, sha1 };
    throw new Error(`${keychain} has no "${SIGNING_NAME}" identity. Remove ${dir} to make a new one (the app then asks for its permissions once more).`);
  }

  log(`making a local signing certificate in ${dir} (once), so rebuilds keep the app's permissions`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const password = randomBytes(24).toString("hex");
  await writeFile(join(dir, "keychain-password"), password + "\n", { mode: 0o600 });
  const work = await mkdtemp(join(tmpdir(), "cos-signing-"));
  try {
    const exportPassword = randomBytes(24).toString("hex");
    await writeFile(
      join(work, "cert.cnf"),
      [
        "[req]", "distinguished_name = dn", "x509_extensions = ext", "prompt = no",
        "[dn]", `CN = ${SIGNING_NAME}`,
        "[ext]", "basicConstraints = critical, CA:false", "keyUsage = critical, digitalSignature", "extendedKeyUsage = critical, codeSigning", "subjectKeyIdentifier = hash",
      ].join("\n") + "\n",
    );
    // macOS's own openssl (LibreSSL) writes a .p12 the keychain can import.
    const openssl = existsSync("/usr/bin/openssl") ? "/usr/bin/openssl" : "openssl";
    await exec(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650", "-keyout", join(work, "key.pem"), "-out", join(work, "cert.pem"), "-config", join(work, "cert.cnf")]);
    await exec(openssl, ["pkcs12", "-export", "-inkey", join(work, "key.pem"), "-in", join(work, "cert.pem"), "-out", join(work, "id.p12"), "-passout", `pass:${exportPassword}`, "-name", SIGNING_NAME]);
    await exec("security", ["create-keychain", "-p", password, keychain]);
    await exec("security", ["set-keychain-settings", keychain]); // no auto-lock
    await exec("security", ["unlock-keychain", "-p", password, keychain]);
    await exec("security", ["import", join(work, "id.p12"), "-k", keychain, "-P", exportPassword, "-T", "/usr/bin/codesign"]);
    // Let codesign use the key without asking.
    await exec("security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, keychain]);
    await chmod(keychain, 0o600);
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  } finally {
    await rm(work, { recursive: true, force: true }); // the private key only lives in the keychain
  }
  const sha1 = await findIn(keychain);
  if (!sha1) throw new Error("The signing certificate was made but can't be found in its keychain.");
  return { keychain, sha1 };
}
