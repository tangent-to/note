/**
 * Who may talk to the companion.
 *
 * The companion listens on 127.0.0.1, but that does not make it private: every
 * web page open in the reader's browser runs on the same machine and can send
 * requests to localhost. A WebSocket is not bound by the same-origin policy at
 * all, so until this guard existed any site the reader visited while
 * `note serve` ran could open `/__sync`, read every notebook under the served
 * directory, and overwrite them. The file endpoints for the working directory
 * would have extended that to every file.
 *
 * Three checks, each closing a different door:
 *
 * - **Host** must name this machine and this port. Otherwise a page on
 *   `evil.example` whose DNS is switched to 127.0.0.1 after it loads (DNS
 *   rebinding) talks to the companion as if it were same-origin.
 * - **Origin**, when the browser sends one, must be the app itself. Browsers
 *   always send it on a WebSocket handshake and on cross-origin requests.
 * - **Sec-Fetch-Site**, when sent, must say the request came from the app's own
 *   pages (`same-origin`) or from the reader typing a URL (`none`). It covers
 *   the requests that carry no Origin, such as a same-site GET.
 *
 * A request with none of these headers is a local program (curl, a script),
 * which can read the files directly anyway, so it is let through.
 *
 * Pure, so the rules are tested without a server.
 */

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Origins the app is served from on this port. */
export function allowedOrigins(port: number): Set<string> {
  return new Set([...LOCAL_HOSTNAMES].map((host) => `http://${host}:${port}`));
}

export function checkRequest(
  header: (name: string) => string | null,
  port: number
): GuardResult {
  const host = header('host');
  if (host !== null) {
    const expected = [...LOCAL_HOSTNAMES].map((h) => `${h}:${port}`);
    if (!expected.includes(host.toLowerCase())) {
      return { ok: false, reason: `unexpected Host ${host}` };
    }
  }

  const origin = header('origin');
  if (origin !== null && !allowedOrigins(port).has(origin.toLowerCase())) {
    return { ok: false, reason: `request from ${origin}` };
  }

  const site = header('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') {
    return { ok: false, reason: `${site} request` };
  }

  return { ok: true };
}
