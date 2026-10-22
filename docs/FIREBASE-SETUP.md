# Setting up cloud sync (Firebase + Google Sign-In)

Seren can run entirely on one device with no setup at all. This guide turns on
**"Continue with Google"** and **cross-device sync** — your lessons, reports,
transcripts and drafts follow your Google account to any computer.

Nothing here costs money. The [Firebase free tier (Spark plan)](https://firebase.google.com/pricing)
gives you 1 GiB of storage, 50k reads/day and 20k writes/day — plenty for a
personal app, with no credit card required.

---

## How it works

```
   ┌───────────────────────────┐
   │  Seren (Electron / web)   │
   └─────────────┬─────────────┘
                 │  1. "Continue with Google"
                 ▼
   ┌───────────────────────────┐      2. user picks an account
   │  System browser            │◄────────(Google's consent screen)
   │  (Google's consent screen) │
   └─────────────┬─────────────┘
                 │  3. redirect to http://localhost:<port>
                 ▼
   ┌───────────────────────────┐
   │  Seren's local server     │  4. exchanges the code (PKCE)
   │  (loopback listener)      │     → Google ID token
   └─────────────┬─────────────┘
                 │  5. ID token → Firebase session
                 ▼
   ┌───────────────────────────┐
   │  Firebase Auth + Firestore │  6. data lives under your user id
   └───────────────────────────┘
```

Seren also offers **email & password** sign-in. That path is shorter: the
client SDK talks to Firebase Auth directly, so there is no browser round-trip
and no local server involved — the password never reaches Seren. Both methods
end up in the same Firebase user id space, so an email account syncs exactly
like a Google one.

Two design notes worth knowing:

- **The consent screen runs in your real browser, never inside the app.**
  Google refuses to show OAuth consent inside an embedded user agent
  (Electron), so the app hands the URL to your OS browser. The redirect comes
  back to a short-lived listener on `localhost`, so **no server of yours is
  involved** — the flow completes entirely on your own machine.
- **The Firebase web config is public.** It ships inside every Firebase app
  in the world; access is enforced by `firestore.rules`, not by hiding a key.
  That is why your users never have to paste anything.

---

## Step 1 — Create a Firebase project

1. Go to <https://console.firebase.google.com> and click **Add project**.
2. Name it (e.g. `seren`) and continue. Google Analytics is optional.
3. Once created, click the **Web** icon (`</>`) in the project overview to
   register a web app. Give it any nickname and **do not** tick Firebase
   Hosting yet.
4. Firebase shows you a `firebaseConfig` object. Keep it — you need it in step 5.

## Step 2 — Enable Google sign-in

1. In the Firebase console, open **Build → Authentication → Get started**.
2. Click **Sign-in method**, then **Google**.
3. Enable it and **Save**.

   Firebase automatically creates a **Web client** OAuth credential for you.

4. Still on the Google provider card, click **Edit** and expand
   **"Whitelist client IDs from external projects (optional)"**.
5. Paste the **Desktop app** client id you create in step 3 into that field
   and click **Add**.

   *Why:* the ID token Seren receives is issued to your *Desktop* client, and
   Firebase only accepts ID tokens from OAuth clients it knows about. Adding
   the desktop client id here is what makes the token acceptable.

## Step 2b — Enable Email & password sign-in (optional)

Seren offers **two** ways in, and the learner picks on the sign-in screen:
*Continue with Google* and *Email & password*. Both create the same kind of
Firebase user, so an email account gets the same cloud storage
(`users/{uid}/kv`) and the same cross-device sync.

To offer email sign-in:

1. In the Firebase console open **Build → Authentication → Sign-in method**.
2. Click **Email/Password**, enable it and **Save**.

Without this the email tab still renders, but signing in fails with
*"Email sign-in is not enabled for this Firebase project yet"* — the app
tells the user exactly that rather than failing silently.

Notes:
* Firebase never sends the password to Seren. The client SDK talks to
  Firebase directly, exactly like the Google flow.
* New accounts need **8 characters or more**; sign-in accepts anything
  Firebase could already have stored (6+).
* **Authentication → Templates** lets you customise the "reset your password"
  email that the *Forgot password?* link sends.

## Step 3 — Create the Desktop app OAuth client

1. Open the **Google Cloud console** → **APIs & Services** → **Credentials**.
   (Make sure the project selected at the top is the same one as your Firebase
   project.)
2. Click **Create credentials → OAuth client ID**.
3. Choose **Application type: Desktop app**, name it `Seren`, and create it.
4. Copy the **Client ID** — you need it for steps 4 and 5.

   The client **secret is optional**. A desktop app is a public client:
   RFC 8252 §8.4 says its secret "should not be treated as confidential"
   because it ships inside every copy of the binary. Seren uses PKCE, which is
   what actually protects the flow. If your Google project insists on a
   secret, set `GOOGLE_OAUTH_CLIENT_SECRET` too.

## Step 4 — Create the Firestore database

1. In the Firebase console open **Build → Firestore Database**.
2. Click **Create database**, pick a **location** close to your users, and
   choose **Start in production mode**.
3. Leave the free (Spark) plan selected.

## Step 5 — Configure Seren

Copy the config into your `.env` file (see `.env.example`):

```bash
VITE_FIREBASE_API_KEY=AIza...
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_APP_ID=1:1234567890:web:abcdef

GOOGLE_OAUTH_CLIENT_ID=1234567890-abcdef.apps.googleusercontent.com
```

Restart the app (`npm run dev` or relaunch the desktop app).

> The `VITE_` prefix matters: Vite only exposes variables with that prefix to
> the renderer. `GOOGLE_OAUTH_CLIENT_ID` has no prefix because only the
> *server* reads it — the client id never reaches the renderer.

## Step 6 — Deploy the security rules

The rules are what actually protect each learner's data. They live in
`firestore.rules` and must be deployed to the project:

```bash
npm install -g firebase-tools
firebase login
firebase use --add          # pick your project
firebase deploy --only firestore:rules
```

Or paste the contents of `firestore.rules` into the Firebase console under
**Firestore Database → Rules → Publish**.

The rule is one line of logic:

```
match /users/{userId}/{document=**} {
  allow read, write: if request.auth != null && request.auth.uid == userId;
}
```

A user can only touch documents under their own id. Nobody — including you —
can read another learner's transcripts through the API.

---

## Verify it works

1. Launch Seren and click **Continue with Google**.
2. Your browser opens Google's account chooser — pick an account.
3. The browser tab shows *"Signed in with Google. You can close this tab."*
4. Seren signs you in and your progress is now in the cloud.
5. Open a second browser profile (or another machine), sign in with the same
   account, and your history is there.

---

## Troubleshooting

**"Sign-in failed" / `auth/operation-not-allowed`**
The Google provider is not enabled, or the desktop client id was not
whitelisted. Re-check step 2.5.

**The browser opens but nothing happens**
The loopback redirect did not come back. Check that
`GOOGLE_OAUTH_REDIRECT_HOST=localhost` (the default) and that nothing else
is squatting on the ephemeral port. Try `GOOGLE_OAUTH_REDIRECT_HOST=127.0.0.1`
if your browser resolves `localhost` oddly.

**`auth/invalid-credential` when exchanging the ID token**
The ID token's audience (`aud`) is not accepted. The desktop client id must
be listed under the Google provider's whitelist (step 2.5) — this is the most
commonly missed step.

**"Cloud sync isn't configured in this build"**
The `VITE_FIREBASE_*` variables are missing. Remember the `VITE_` prefix and
that they are read at **build** time — restart the dev server (or rebuild)
after editing `.env`.

**Firestore says "Missing or insufficient permissions"**
The rules were not deployed (step 6). Publishing them in the console works
just as well as the CLI.

---

## What this replaces

Earlier versions of Seren shipped a bespoke email/password account system
backed by a local SQLite database, plus a self-hosted sync server you had to
deploy and point every device at. That is gone:

| Before | Now |
|---|---|
| Email + password, no password reset | Google account — no password to remember or reset |
| Sessions were opaque bearer tokens in `localStorage` | Firebase Auth handles sessions, refresh and revocation |
| Data lived on a server **you** had to host | Data lives in Firestore — Google hosts it, free |
| Cross-device sync required deploying a server | Cross-device sync works out of the box |
| Data isolated by app logic | Data isolated by `firestore.rules` |

---

## Cost and limits at a glance

| Resource | Free tier | Notes |
|---|---|---|
| Firestore storage | 1 GiB | Shared across all users of the project |
| Firestore reads | 50,000 / day | One read per document per sync |
| Firestore writes | 20,000 / day | Batched — one write per changed key |
| Firebase Auth (Google) | 3,000 daily active users | Email sign-in is also available |
| Google OAuth | unlimited | Free forever for a desktop app |

If you outgrow the free tier, enable the **Blaze** plan — it is pay-as-you-go
with no minimum, so a small app usually still costs $0.

---

## Publishing for other users

Because the Firebase config is public by design, you can ship the app with
your project's config baked in and every user gets working sign-in and sync
with **zero setup**. That is exactly how this repository is intended to be
used: clone → add your own Firebase project → build.

If you would rather each user bring their own Firebase project, leave the
`VITE_FIREBASE_*` variables unset — Seren then runs in **offline mode**:
everything works, progress stays on the device, and the sign-in screen
explains how to enable cloud sync.
