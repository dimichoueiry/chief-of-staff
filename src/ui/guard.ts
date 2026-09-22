/**
 * Who may talk to the local server. It listens on loopback, but any website open in a browser
 * can still send requests to 127.0.0.1, so loopback alone is not a boundary. The server's own
 * pages, the menubar app and the CLI are the only callers; everything else is refused here,
 * before a route runs.
 */
import type { IncomingHttpHeaders } from "node:http";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface Refusal {
  status: number;
  error: string;
}

/** Why a request is refused, or null when it may go on. */
export function refuse(req: { method?: string; headers: IncomingHttpHeaders }, pathname: string): Refusal | null {
  const h = req.headers;
  // A loopback name in Host is what stops DNS rebinding: a site that points its own name at
  // 127.0.0.1 still sends its own name here.
  const host = h.host ?? "";
  if (!LOOPBACK.has(hostname(host))) return { status: 403, error: "host not allowed" };
  if (!pathname.startsWith("/api/")) return null;

  // Browsers say who is asking. The server's own pages are same-origin; the menubar app and the
  // CLI send neither header. A sandboxed artifact page sends Origin "null", and is refused too.
  const origin = h.origin;
  if (origin !== undefined && origin !== `http://${host}`) return { status: 403, error: "origin not allowed" };
  const site = h["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return { status: 403, error: "cross-site request" };

  // A body has to be declared JSON. A cross-site page can only send a JSON content type after
  // a preflight this server never answers, so this holds even for a browser that sends no Origin.
  const hasBody = Number(h["content-length"] ?? 0) > 0 || h["transfer-encoding"] !== undefined;
  if (hasBody && req.method !== "GET" && req.method !== "HEAD" && mediaType(h["content-type"]) !== "application/json") {
    return { status: 415, error: "send JSON (content-type: application/json)" };
  }
  return null;
}

function hostname(host: string): string {
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1).toLowerCase();
  return host.split(":")[0].toLowerCase();
}

function mediaType(contentType: string | undefined): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}
