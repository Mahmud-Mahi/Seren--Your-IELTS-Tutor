/**
 * Session layer built on Firebase Auth.
 *
 * Replaces the bespoke email/password account store (`src/server/accounts.ts`).
 * Firebase owns identity, sessions and token refresh; the app only ever holds
 * a short-lived ID token, and Firestore Security Rules decide what that token
 * may read or write.
 *
 * The sign-in flow is:
 *   1. `POST /api/auth/google/start` → the local server opens a loopback
 *      listener and returns the Google consent URL.
 *   2. The renderer opens that URL in the user's REAL browser (Electron's
 *      `shell.openExternal` / `window.open`), so Google never sees an
 *      embedded user agent.
 *   3. Google redirects back to the loopback listener; the server exchanges
 *      the code and keeps the Google ID token.
 *   4. The renderer polls `GET /api/auth/google/result` until the ID token
 *      arrives, then swaps it for a Firebase session with
 *      `signInWithCredential(auth, GoogleAuthProvider.credential(idToken))`.
 *
 * The Firebase session (including the refresh token) is persisted by the SDK
 * itself, so "logged in" survives restarts without us storing any token.
 */
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithCredential,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';
import { firebaseAuth } from '../firebase/client';
import { isFirebaseConfigured } from '../firebase/config';

/** The identity of the signed-in user, as the rest of the app sees it. */
export interface AuthSession {
  /** Firebase user id — the stable key every profile is stored under. */
  uid: string;
  /** Google email of the account (may be null in rare privacy configs). */
  email: string | null;
  /** Display name from the Google profile. */
  displayName: string | null;
  /** Profile picture URL from the Google profile. */
  photoURL: string | null;
}

/**
 * The sentinel user id used when no cloud account is signed in (the app runs
 * in offline mode). It is deliberately NOT a real Firebase uid, so it can
 * never collide with a cloud account.
 */
export const LOCAL_ONLY_UID = 'offline';

/** True when this session is the offline (no cloud account) sentinel. */
export function isLocalOnlySession(session: AuthSession | null): boolean {
  return session?.uid === LOCAL_ONLY_UID;
}

export interface AuthError {
  ok: false;
  error: string;
}

/** The outcome of a sign-in attempt. */
export type SignInResult = { ok: true; session: AuthSession } | AuthError;

/** True when cloud sign-in is available at all (a Firebase project exists). */
export function isCloudAuthAvailable(): boolean {
  return isFirebaseConfigured();
}

/** Converts a Firebase user into the app's session shape. */
function toSession(user: User): AuthSession {
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    photoURL: user.photoURL,
  };
}

/**
 * Subscribes to sign-in state changes. Fires immediately with the current
 * user (or null) once the SDK has restored any persisted session.
 */
export function onSessionChange(callback: (session: AuthSession | null) => void): () => void {
  const auth = firebaseAuth();
  if (!auth) {
    callback(null);
    return () => {};
  }
  return onAuthStateChanged(auth, (user) => {
    callback(user ? toSession(user) : null);
  });
}

/** The currently signed-in session, or null. */
export function currentSession(): AuthSession | null {
  const auth = firebaseAuth();
  const user = auth?.currentUser;
  return user ? toSession(user) : null;
}

/**
 * Starts the "Continue with Google" flow and resolves with the signed-in
 * session, or an error the UI can show.
 */
export async function signInWithGoogle(): Promise<SignInResult> {
  const auth = firebaseAuth();
  if (!auth) return { ok: false, error: 'cloud_not_configured' };

  let start: { id: string; url: string };
  try {
    const response = await fetch('/api/auth/google/start', { method: 'POST' });
    if (!response.ok) throw new Error(`start_failed_${response.status}`);
    start = await response.json();
  } catch {
    return { ok: false, error: 'network' };
  }
  if (!start?.url || !start?.id) return { ok: false, error: 'start_failed' };

  // Open the consent screen in the user's real browser. Google refuses to run
  // its consent flow inside an embedded user agent, so this must NOT happen
  // in the Electron window. In the desktop shell we ask the main process to
  // use the OS browser; in a plain browser tab `window.open` does the same.
  const opened = await openConsentWindow(start.url);
  if (!opened) return { ok: false, error: 'popup_blocked' };

  const idToken = await pollForIdToken(start.id);
  if (!idToken) return { ok: false, error: 'sign_in_cancelled' };

  try {
    const credential = GoogleAuthProvider.credential(idToken);
    const result = await signInWithCredential(auth, credential);
    return { ok: true, session: toSession(result.user) };
  } catch (error: any) {
    const code = String(error?.code || '');
    if (code === 'auth/account-exists-with-different-credential') {
      return { ok: false, error: 'account_exists' };
    }
    if (code === 'auth/unauthorized-domain' || code === 'auth/operation-not-allowed') {
      return { ok: false, error: 'provider_not_enabled' };
    }
    return { ok: false, error: 'sign_in_failed' };
  }
}

/**
 * Opens the Google consent screen in the user's real browser.
 *
 * In the Electron shell the renderer cannot open windows itself, so the main
 * process is asked to launch the OS browser. Everywhere else `window.open`
 * does the job. Returns false when the browser refused (popup blocked).
 */
async function openConsentWindow(url: string): Promise<boolean> {
  const desktop = (window as any).serenDesktop;
  if (desktop?.openExternal) {
    try {
      return await desktop.openExternal(url);
    } catch {
      return false;
    }
  }
  try {
    // Note: do NOT pass `noopener` here — with noopener modern browsers
    // return `null` from window.open even when the popup was allowed, which
    // made Seren wrongly report "popup blocked". We still detach the opener
    // afterwards for safety.
    const popup = window.open(url, '_blank');
    if (popup) {
      try {
        popup.opener = null;
      } catch {
        // ignore — cross-origin windows may not allow this
      }
    }
    // A null handle means the browser blocked the popup.
    return Boolean(popup);
  } catch {
    return false;
  }
}

/**
 * Polls the local server for the Google ID token the loopback listener
 * captured. The user completes the consent screen in their browser, so this
 * can legitimately take a while — the server gives up after 10 minutes.
 */
async function pollForIdToken(requestId: string): Promise<string | null> {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    let body: any;
    try {
      const response = await fetch(`/api/auth/google/result?id=${encodeURIComponent(requestId)}`);
      if (!response.ok) continue;
      body = await response.json();
    } catch {
      continue; // server restarting — keep waiting
    }
    if (body?.status === 'done' && typeof body.idToken === 'string') return body.idToken;
    if (body?.status === 'error') return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Email & password sign-in
//
// Firebase Auth owns the credentials — Seren never sees or stores the
// password, exactly like the Google flow. The account lives in the same
// Firebase user id space, so an email account gets the SAME cloud storage
// (users/{uid}/kv) and the same cross-device sync as a Google one.
// ---------------------------------------------------------------------------

/** The reasons an email sign-in can fail, in the app's own words. */
export type EmailAuthError =
  | 'invalid_credentials'
  | 'email_exists'
  | 'invalid_email'
  | 'weak_password'
  | 'provider_not_enabled'
  | 'too_many_requests'
  | 'network'
  | 'sign_in_failed';

/**
 * Maps a Firebase Auth error code to a stable, user-facing reason.
 * Exported so the mapping can be tested without a live Firebase project.
 */
export function mapEmailAuthErrorCode(code: string): EmailAuthError {
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/invalid-login-credentials':
      return 'invalid_credentials';
    case 'auth/email-already-in-use':
    case 'auth/account-exists-with-different-credential':
    case 'auth/credential-already-in-use':
      return 'email_exists';
    case 'auth/invalid-email':
      return 'invalid_email';
    case 'auth/weak-password':
      return 'weak_password';
    case 'auth/operation-not-allowed':
    case 'auth/unauthorized-domain':
      return 'provider_not_enabled';
    case 'auth/too-many-requests':
      return 'too_many_requests';
    case 'auth/network-request-failed':
      return 'network';
    default:
      return 'sign_in_failed';
  }
}

/** A deliberately simple email check — Firebase does the real validation. */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Firebase's own minimum. Sign-in accepts anything that could exist. */
export const MIN_PASSWORD_LENGTH = 6;
/** Our floor for NEW accounts (stronger than Firebase's minimum). */
export const MIN_NEW_PASSWORD_LENGTH = 8;

/**
 * Validates the form before touching the network.
 * Returns the reason it is invalid, or null when it is fine.
 */
export function validateEmailCredentials(
  email: string,
  password: string,
  mode: 'signin' | 'create'
): EmailAuthError | null {
  const trimmed = (email || '').trim();
  if (!trimmed) return 'invalid_email';
  if (!EMAIL_PATTERN.test(trimmed)) return 'invalid_email';
  const min = mode === 'create' ? MIN_NEW_PASSWORD_LENGTH : MIN_PASSWORD_LENGTH;
  if (!password || password.length < min) return 'weak_password';
  return null;
}

/** Signs in with an existing email + password account. */
export async function signInWithEmail(email: string, password: string): Promise<SignInResult> {
  const auth = firebaseAuth();
  if (!auth) return { ok: false, error: 'cloud_not_configured' };
  const invalid = validateEmailCredentials(email, password, 'signin');
  if (invalid) return { ok: false, error: invalid };
  try {
    const result = await signInWithEmailAndPassword(auth, email.trim(), password);
    return { ok: true, session: toSession(result.user) };
  } catch (error: any) {
    return { ok: false, error: mapEmailAuthErrorCode(String(error?.code || '')) };
  }
}

/** Creates a new email + password account and signs the user in. */
export async function createAccountWithEmail(email: string, password: string): Promise<SignInResult> {
  const auth = firebaseAuth();
  if (!auth) return { ok: false, error: 'cloud_not_configured' };
  const invalid = validateEmailCredentials(email, password, 'create');
  if (invalid) return { ok: false, error: invalid };
  try {
    const result = await createUserWithEmailAndPassword(auth, email.trim(), password);
    return { ok: true, session: toSession(result.user) };
  } catch (error: any) {
    return { ok: false, error: mapEmailAuthErrorCode(String(error?.code || '')) };
  }
}

/**
 * Sends a password-reset email. The reset link lands in the user's inbox and
 * opens the Firebase-hosted handler page, so the flow works even in the
 * desktop app.
 */
export async function sendPasswordReset(email: string): Promise<{ ok: boolean; error?: string }> {
  const auth = firebaseAuth();
  if (!auth) return { ok: false, error: 'cloud_not_configured' };
  if (!EMAIL_PATTERN.test((email || '').trim())) return { ok: false, error: 'invalid_email' };
  try {
    await sendPasswordResetEmail(auth, email.trim());
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: mapEmailAuthErrorCode(String(error?.code || '')) };
  }
}

/** Signs out of Firebase (and therefore of this app). */
export async function signOut(): Promise<void> {
  const auth = firebaseAuth();
  if (auth) await firebaseSignOut(auth);
}
