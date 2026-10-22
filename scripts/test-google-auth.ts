/**
 * Exercises the Google sign-in flow end to end against the REAL module
 * (`src/server/google-auth.ts`), with only Google's token endpoint stubbed.
 *
 * Covered:
 *   - the loopback listener binds an ephemeral port and redirects there
 *   - PKCE: the S256 challenge sent to Google matches the verifier used at
 *     the token exchange
 *   - the `state` nonce is verified (a mismatched state is rejected)
 *   - a successful exchange yields a Google ID token the renderer can use
 *   - a failing exchange surfaces an error instead of hanging
 *
 * Run: npx tsx scripts/test-google-auth.ts
 */
import crypto from 'crypto';

process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = '';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

/** Captures the token-exchange request and answers with a fake ID token. */
interface TokenRequest {
  params: URLSearchParams;
}
let lastTokenRequest: TokenRequest | null = null;
let tokenEndpointShouldFail = false;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any) => {
  const url = String(input);
  if (url.includes('oauth2.googleapis.com/token')) {
    const params = new URLSearchParams(String(init?.body || ''));
    lastTokenRequest = { params };
    if (tokenEndpointShouldFail) {
      return new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'mock failure' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    // The ID token's audience must be the client id we asked with.
    const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        aud: params.get('client_id'),
        sub: 'firebase-uid-123',
        email: 'mahi@example.com',
        iss: 'https://accounts.google.com',
      })
    ).toString('base64url');
    return new Response(
      JSON.stringify({
        id_token: `${header}.${payload}.signature`,
        access_token: 'access-token',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  return realFetch(input, init);
}) as typeof fetch;

async function run(): Promise<void> {
  const { startGoogleAuth, getGoogleAuthResult } = await import('../src/server/google-auth');

  // --- 1. starting a sign-in returns a Google consent URL + an id
  const { id, url } = await startGoogleAuth();
  assert(Boolean(id), 'start returns a request id');
  assert(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth'), 'consent URL points at Google');

  const params = new URL(url).searchParams;
  assert(params.get('client_id') === 'test-client-id.apps.googleusercontent.com', 'client id sent');
  assert(params.get('response_type') === 'code', 'authorization code flow');
  assert(params.get('code_challenge_method') === 'S256', 'PKCE S256 used');
  assert(params.get('prompt') === 'select_account', 'account chooser shown');

  const redirectUri = params.get('redirect_uri') || '';
  assert(/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(redirectUri), `loopback redirect URI: ${redirectUri}`);

  // --- 2. the redirect listener answers on that port and returns the token
  const pending = getGoogleAuthResult(id);
  assert(pending.status === 'pending', 'result starts pending');

  const callback = new URL(redirectUri);
  const response = await realFetch(
    `${callback.origin}/?code=auth-code-1&state=${encodeURIComponent(params.get('state') || '')}`
  );
  assert(response.ok, 'loopback listener answered the redirect');
  const html = await response.text();
  assert(html.includes('Signed in with Google'), 'callback page confirms sign-in');

  const done = getGoogleAuthResult(id);
  assert(done.status === 'done', 'result became done');
  assert(typeof done.idToken === 'string' && done.idToken.length > 20, 'an ID token was captured');

  // --- 3. the token exchange used the SAME PKCE verifier
  assert(lastTokenRequest, 'token endpoint was called');
  const sent = lastTokenRequest.params;
  assert(sent.get('grant_type') === 'authorization_code', 'authorization_code grant');
  assert(sent.get('code') === 'auth-code-1', 'authorization code forwarded');
  assert(sent.get('redirect_uri') === redirectUri, 'same redirect URI at exchange time');
  assert(sent.get('code_verifier'), 'PKCE verifier sent');
  const challenge = crypto
    .createHash('sha256')
    .update(sent.get('code_verifier') || '')
    .digest('base64url');
  assert(challenge === params.get('code_challenge'), 'PKCE verifier matches the challenge');

  // --- 4. a mismatched state is rejected (CSRF protection)
  const second = await startGoogleAuth();
  const secondParams = new URL(second.url).searchParams;
  const secondCallback = new URL(secondParams.get('redirect_uri') || '');
  await realFetch(`${secondCallback.origin}/?code=stolen&state=not-the-right-state`);
  const rejected = getGoogleAuthResult(second.id);
  assert(rejected.status === 'error', 'a bad state is rejected');
  assert(rejected.error === 'invalid_state', 'rejection reports invalid_state');

  // --- 5. a failing token exchange surfaces an error (no hang)
  tokenEndpointShouldFail = true;
  const third = await startGoogleAuth();
  const thirdParams = new URL(third.url).searchParams;
  const thirdCallback = new URL(thirdParams.get('redirect_uri') || '');
  await realFetch(
    `${thirdCallback.origin}/?code=bad&state=${encodeURIComponent(thirdParams.get('state') || '')}`
  );
  const failed = getGoogleAuthResult(third.id);
  assert(failed.status === 'error', 'a failed exchange becomes an error');
  assert(failed.error === 'mock failure', 'the provider error message is surfaced');

  console.log('All Google auth flow tests passed.');
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
