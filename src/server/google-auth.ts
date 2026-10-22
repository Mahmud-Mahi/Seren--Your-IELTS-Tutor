import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';

/**
 * "Continue with Google" for a desktop app.
 *
 * Why this module exists instead of `firebase.auth().signInWithPopup()`:
 * Google refuses to run its consent screen inside an embedded user agent
 * (Electron), and Firebase's own popup flow depends on `window.opener`
 * messaging that a BrowserWindow does not provide. Google's Firebase engineer
 * recommends exactly this alternative for Electron: obtain the Google
 * credential yourself, then hand it to Firebase via `signInWithCredential`.
 *
 * The flow implemented here is Google's documented "OAuth 2.0 for Desktop
 * Apps" flow (RFC 8252 §7.3):
 *
 *   1. `startGoogleAuth()` opens a short-lived HTTP listener on the loopback
 *      interface and returns the Google consent URL. The redirect URI is
 *      `http://localhost:<port>` — a loopback address, which Google accepts
 *      with ANY port for Desktop app clients, so no fixed port is needed.
 *   2. The consent screen runs in the user's real browser (opened by the
 *      renderer), so Google never sees an embedded user agent.
 *   3. Google redirects back to the loopback listener; the listener exchanges
 *      the code for tokens using PKCE and keeps the Google **ID token**.
 *   4. The renderer polls `getGoogleAuthResult()` for the outcome and swaps
 *      the ID token for a Firebase session with `signInWithCredential`.
 *
 * The client secret is OPTIONAL and only needed for client types that Google
 * treats as confidential. A Desktop app client is a public client — RFC 8252
 * §8.4 says its secret "should not be treated as confidential" because it
 * ships inside every install — so PKCE alone is the meaningful protection.
 */

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SCOPES = ['openid', 'email', 'profile'];

/** How long a sign-in attempt stays valid (10 minutes). */
const REQUEST_TTL_MS = 10 * 60 * 1000;
/** How long the loopback listener waits for the user to finish signing in. */
const LISTENER_TTL_MS = 5 * 60 * 1000;

export interface GoogleAuthResult {
  status: 'pending' | 'done' | 'error';
  idToken?: string;
  error?: string;
}

interface PendingAuth {
  id: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
  result: GoogleAuthResult;
  listeners: http.Server[];
}

export interface GoogleAuthConfig {
  clientId: string;
  clientSecret: string;
  /**
   * Host used in the redirect URI. `localhost` is the value Google accepts
   * for Desktop app clients; the listener is bound on both loopback families
   * so it answers however the browser resolves the name.
   */
  redirectHost: string;
}

/**
 * Configuration of the OAuth client. `GOOGLE_OAUTH_CLIENT_ID` is the client id
 * of a **Desktop app** OAuth client (Google Cloud console → APIs & Services →
 * Credentials → Create credentials → OAuth client ID → Desktop app).
 */
export function googleAuthConfig(): GoogleAuthConfig {
  return {
    clientId: (process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim(),
    clientSecret: (process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim(),
    redirectHost: (process.env.GOOGLE_OAUTH_REDIRECT_HOST || 'localhost').trim(),
  };
}

export function isGoogleAuthConfigured(): boolean {
  return Boolean(googleAuthConfig().clientId);
}

const pending = new Map<string, PendingAuth>();

function sweep(): void {
  const cutoff = Date.now() - REQUEST_TTL_MS;
  for (const [id, request] of pending) {
    if (request.createdAt < cutoff) {
      closeListeners(request);
      pending.delete(id);
    }
  }
}

function closeListeners(request: PendingAuth): void {
  for (const listener of request.listeners) {
    try {
      listener.close();
    } catch {}
  }
  request.listeners = [];
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Starts a sign-in attempt: binds a loopback listener and returns the Google
 * consent URL to open in the user's browser, plus the attempt id used to
 * collect the outcome.
 */
export async function startGoogleAuth(): Promise<{ id: string; url: string }> {
  sweep();
  const config = googleAuthConfig();
  if (!config.clientId) throw new Error('google_oauth_not_configured');

  const state = base64Url(crypto.randomBytes(24));
  const codeVerifier = base64Url(crypto.randomBytes(48));
  const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
  const id = base64Url(crypto.randomBytes(12));

  const request: PendingAuth = {
    id,
    state,
    codeVerifier,
    redirectUri: '',
    createdAt: Date.now(),
    result: { status: 'pending' },
    listeners: [],
  };
  pending.set(id, request);

  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    void handleCallback(request, req, res);
  };

  // Bind an ephemeral port on BOTH loopback families. A browser may resolve
  // `localhost` to ::1 or to 127.0.0.1 depending on the machine, so the
  // listener must answer on whichever one it picks.
  const hosts = config.redirectHost === 'localhost' ? ['127.0.0.1', '::1'] : [config.redirectHost];
  const bound: number[] = [];
  for (const host of hosts) {
    const listener = http.createServer(handler);
    try {
      await new Promise<void>((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, host, () => resolve());
      });
    } catch (error) {
      // One family may be unavailable (no IPv6 stack, say) — as long as at
      // least one bound, the redirect can still arrive.
      closeListeners(request);
      pending.delete(id);
      throw error;
    }
    request.listeners.push(listener);
    bound.push((listener.address() as AddressInfo).port);
  }

  // Google treats every port of a loopback redirect URI as equivalent, but
  // the port we send must be one we are actually listening on.
  const port = bound[0];
  // No path component: Google validates Desktop app redirect URIs as
  // "loopback host + any port", and the browser requests "/" anyway.
  request.redirectUri = `http://${config.redirectHost}:${port}`;

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: request.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    // Always show the account chooser — a learner may have several Google
    // accounts and should not be silently signed into the wrong one.
    prompt: 'select_account',
  });

  // Give up on the listener if the user never comes back.
  const timer = setTimeout(() => {
    const current = pending.get(id);
    if (current && current.result.status === 'pending') {
      current.result = { status: 'error', error: 'timed_out' };
      closeListeners(current);
    }
  }, LISTENER_TTL_MS);
  timer.unref?.();

  return { id, url: `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}` };
}

/** The outcome of a sign-in attempt. */
export function getGoogleAuthResult(id: string): GoogleAuthResult {
  sweep();
  const request = pending.get(id);
  if (!request) return { status: 'error', error: 'unknown_request' };
  return request.result;
}

/** Exchanges the authorization code for tokens and keeps the Google ID token. */
async function exchangeCode(request: PendingAuth, code: string): Promise<string> {
  const config = googleAuthConfig();
  const body = new URLSearchParams({
    client_id: config.clientId,
    code,
    code_verifier: request.codeVerifier,
    redirect_uri: request.redirectUri,
    grant_type: 'authorization_code',
  });
  if (config.clientSecret) body.set('client_secret', config.clientSecret);

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const payload: any = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload?.error_description ||
      payload?.error ||
      `token_exchange_failed_${response.status}`;
    throw new Error(message);
  }
  const idToken = typeof payload?.id_token === 'string' ? payload.id_token : '';
  if (!idToken) throw new Error('missing_id_token');
  return idToken;
}

/** Handles the loopback redirect coming back from Google. */
async function handleCallback(
  request: PendingAuth,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const url = new URL(req.url || '/', `http://${request.redirectUri}`);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  const respond = (body: string) => {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch {}
    closeListeners(request);
  };

  if (error) {
    request.result = { status: 'error', error };
    respond(callbackPage('Sign-in was cancelled.'));
    return;
  }
  if (!code || state !== request.state) {
    request.result = { status: 'error', error: 'invalid_state' };
    respond(callbackPage('Sign-in could not be verified.'));
    return;
  }

  try {
    const idToken = await exchangeCode(request, code);
    request.result = { status: 'done', idToken };
    respond(callbackPage('Signed in with Google.'));
  } catch (err: any) {
    request.result = { status: 'error', error: err?.message || 'token_exchange_failed' };
    respond(callbackPage('Sign-in failed.'));
  }
}

/**
 * The "you can close this tab" page shown after the sign-in completes in the
 * system browser. The desktop app picks the result up by polling.
 */
function callbackPage(message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Seren</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#21222c; color:#f8f8f2; font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif; }
  .card { text-align:center; padding:2.5rem; }
  .dot { width:56px; height:56px; margin:0 auto 1rem; border-radius:50%;
         background:#50fa7b22; display:flex; align-items:center; justify-content:center;
         font-size:1.75rem; color:#50fa7b; }
  h1 { margin:0 0 .5rem; font-size:1.25rem; }
  p { margin:0; color:#6272a4; font-size:.9rem; }
</style>
</head>
<body>
  <div class="card">
    <div class="dot">&#10003;</div>
    <h1>${message}</h1>
    <p>You can close this tab and return to Seren.</p>
  </div>
</body>
</html>`;
}
