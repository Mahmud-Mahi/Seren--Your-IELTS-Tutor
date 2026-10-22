/**
 * Firebase + Google OAuth configuration.
 *
 * These values are PUBLIC BY DESIGN — the Firebase web config ships inside
 * every Firebase app in the world. The web `apiKey` is not a secret: it only
 * identifies the project, and access is enforced by Firestore Security Rules
 * (see `firestore.rules`), never by hiding a key.
 *
 * That is why Seren can ship a working "Continue with Google" button without
 * the user ever pasting a key, and why the API keys in the app are safe to
 * publish in an open-source repository.
 *
 * Configure either way:
 *   - build time:  VITE_FIREBASE_API_KEY=... in `.env` (see `.env.example`)
 *   - source time: edit `PROJECT` below before releasing a build
 */

export interface FirebaseProjectConfig {
  /** Firebase web API key — public, identifies the project only. */
  apiKey: string;
  /** e.g. "my-project.firebaseapp.com" — where Firebase Auth lives. */
  authDomain: string;
  /** The Firebase project id. */
  projectId: string;
  /** Cloud Storage bucket (unused today, kept for future uploads). */
  storageBucket: string;
  /** The Firebase web app id. */
  appId: string;
  /** Optional analytics id. */
  measurementId?: string;
}

/**
 * Project to bake into the build. Leave the strings empty and set the
 * VITE_FIREBASE_* environment variables instead (recommended for forks:
 * one `.env` file, no source edits).
 */
const PROJECT: Partial<FirebaseProjectConfig> = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  appId: '',
  measurementId: '',
};

/**
 * Google OAuth client used for "Continue with Google".
 *
 * This lives on the SERVER, not here — the renderer never sees the client id
 * or secret. See `src/server/google-auth.ts` and `GOOGLE_OAUTH_CLIENT_ID` in
 * `.env.example`.
 *
 * Use a **Desktop app** client (Google Cloud console → APIs & Services →
 * Credentials → Create credentials → OAuth client ID → Desktop app). Desktop
 * clients are public clients: RFC 8252 §8.4 says the client secret of an
 * installed app "should not be treated as confidential", because it ships
 * inside every copy of the binary. PKCE (see `src/server/google-auth.ts`) is
 * what actually protects the flow, so the secret is optional.
 *
 * The client id must also be whitelisted for the Google provider in the
 * Firebase console — see `docs/FIREBASE-SETUP.md`.
 */

const env = (typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : {}) as Record<
  string,
  string | undefined
>;

function pick(envKey: string, fallback: string | undefined): string {
  const fromEnv = env[envKey];
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  return fallback || '';
}

export const firebaseConfig: FirebaseProjectConfig = {
  apiKey: pick('VITE_FIREBASE_API_KEY', PROJECT.apiKey),
  authDomain: pick('VITE_FIREBASE_AUTH_DOMAIN', PROJECT.authDomain),
  projectId: pick('VITE_FIREBASE_PROJECT_ID', PROJECT.projectId),
  storageBucket: pick('VITE_FIREBASE_STORAGE_BUCKET', PROJECT.storageBucket),
  appId: pick('VITE_FIREBASE_APP_ID', PROJECT.appId),
  measurementId: pick('VITE_FIREBASE_MEASUREMENT_ID', PROJECT.measurementId),
};

/**
 * True when a Firebase project is wired up. The app degrades gracefully when
 * this is false: Seren still runs, but progress stays on this device and the
 * sign-in screen explains how to enable cloud sync.
 */
export function isFirebaseConfigured(): boolean {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId);
}
