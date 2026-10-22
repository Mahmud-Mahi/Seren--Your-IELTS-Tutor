/**
 * Firebase client singletons.
 *
 * Everything is created lazily so that importing this module never throws —
 * a build without Firebase configuration (or a user running from source
 * before setting up their project) must still boot the app and show a useful
 * "cloud sync is not configured" message instead of a blank screen.
 */
import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';
import { firebaseConfig, isFirebaseConfigured } from './config';

let app: FirebaseApp | null = null;
let authInstance: Auth | null = null;
let firestore: Firestore | null = null;

/** The Firebase app, or null when no project is configured. */
export function firebaseApp(): FirebaseApp | null {
  if (!isFirebaseConfigured()) return null;
  if (app) return app;
  app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  return app;
}

/** The Firebase Auth instance, or null when no project is configured. */
export function firebaseAuth(): Auth | null {
  const target = firebaseApp();
  if (!target) return null;
  if (!authInstance) authInstance = getAuth(target);
  return authInstance;
}

/** The Firestore instance, or null when no project is configured. */
export function firebaseDb(): Firestore | null {
  const target = firebaseApp();
  if (!target) return null;
  if (!firestore) firestore = getFirestore(target);
  return firestore;
}
