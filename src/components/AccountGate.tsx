import React, { useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertCircle,
  CloudOff,
  Eye,
  EyeOff,
  Loader2,
  LogIn,
  Mail,
  ShieldCheck,
  Sparkles,
  UserPlus,
} from 'lucide-react';
import {
  isCloudAuthAvailable,
  LOCAL_ONLY_UID,
  createAccountWithEmail,
  sendPasswordReset,
  signInWithEmail,
  signInWithGoogle,
  type AuthSession,
} from '../auth/session';
import { SEREN_PROFILE_IMAGE } from '../assets/characterAssets';

/**
 * First-run gate — shown instead of the app until the user signs in.
 *
 * Two ways in, and the learner picks:
 *   • Continue with Google — the consent screen opens in the REAL browser
 *     (Google refuses embedded user agents), and the local server brokers the
 *     code exchange.
 *   • Email & password — handled entirely by Firebase Auth in the client, so
 *     Seren never sees the password.
 *
 * Both land in the same Firebase user id space, so an email account gets the
 * SAME cloud storage (users/{uid}/kv) and the same cross-device sync as a
 * Google one.
 *
 * When no Firebase project is configured (a fresh clone without setup), the
 * gate still renders but offers "Continue offline" so the app remains usable
 * — progress simply stays on this device.
 */
interface AccountGateProps {
  onAuthed: (session: AuthSession) => Promise<void> | void;
}

const ERROR_TEXT: Record<string, string> = {
  network: 'Can’t reach the Seren server. Is the app still starting up?',
  popup_blocked: 'Your browser blocked the sign-in window — please allow pop-ups for Seren.',
  sign_in_cancelled: 'Sign-in was cancelled.',
  sign_in_failed: 'Sign-in failed. Please try again.',
  provider_not_enabled: 'Google sign-in is not enabled for this Firebase project yet.',
  account_exists: 'An account already exists with this email using a different sign-in method.',
  cloud_not_configured: 'Cloud sync is not configured for this build.',
  // email & password
  invalid_credentials: 'That email and password do not match an account.',
  email_exists:
    'An account already exists with this email. Sign in instead — or use Google if you signed up with Google.',
  invalid_email: 'That does not look like a valid email address.',
  weak_password: 'Password is too short — use at least 8 characters.',
  too_many_requests: 'Too many attempts. Wait a minute and try again.',
};

type AuthMode = 'google' | 'email';

/** The Google "G" mark, drawn inline so no external asset is needed. */
const GoogleMark = () => (
  <svg viewBox="0 0 24 24" className="w-[18px] h-[18px]" aria-hidden="true">
    <path
      fill="#4285F4"
      d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.53 5.53 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81Z"
    />
    <path
      fill="#34A853"
      d="M12 24c3.24 0 5.95-1.08 7.94-2.91l-3.88-3c-1.08.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.73-4.96H1.26v3.1A12 12 0 0 0 12 24Z"
    />
    <path
      fill="#FBBC05"
      d="M5.27 14.28a7.2 7.2 0 0 1 0-4.56v-3.1H1.26a12 12 0 0 0 0 10.76l4.01-3.1Z"
    />
    <path
      fill="#EA4335"
      d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.43-3.43C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.26 6.62l4.01 3.1C6.22 6.86 8.87 4.75 12 4.75Z"
    />
  </svg>
);

export const AccountGate: React.FC<AccountGateProps> = ({ onAuthed }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<AuthMode>('google');
  // 'signin' = use an existing account, 'create' = make a new one.
  const [emailAction, setEmailAction] = useState<'signin' | 'create'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const cloudAvailable = isCloudAuthAvailable();

  const showError = (code: string) => {
    setError(ERROR_TEXT[code] || ERROR_TEXT.sign_in_failed);
    setNotice(null);
  };

  const handleGoogleSignIn = async () => {
    if (busy) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await signInWithGoogle();
      // Explicit `=== false`: the project tsconfig runs without
      // strictNullChecks, where only explicit boolean comparisons narrow a
      // discriminated union (same reason routes/accounts.ts does this).
      if (result.ok === false) {
        showError(result.error);
        setBusy(false);
        return;
      }
      await onAuthed(result.session);
      // onAuthed flips the shell to the app; keep the spinner until then.
    } catch {
      setError(ERROR_TEXT.network);
      setBusy(false);
    }
  };

  const handleEmailAuth = async () => {
    if (busy) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result =
        emailAction === 'create'
          ? await createAccountWithEmail(email, password)
          : await signInWithEmail(email, password);
      if (result.ok === false) {
        showError(result.error);
        setBusy(false);
        return;
      }
      await onAuthed(result.session);
    } catch {
      setError(ERROR_TEXT.network);
      setBusy(false);
    }
  };

  const handleForgotPassword = async () => {
    if (busy) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    const result = await sendPasswordReset(email);
    setBusy(false);
    if (result.ok) {
      setNotice(`If an account exists for ${email.trim()}, a reset link is on its way.`);
    } else {
      showError(result.error || 'sign_in_failed');
    }
  };

  const handleContinueOffline = () => {
    // No cloud project configured: run the app without an account. Progress
    // stays on this device only.
    onAuthed({
      uid: LOCAL_ONLY_UID,
      email: null,
      displayName: null,
      photoURL: null,
    });
  };

  const inputClass =
    'w-full px-3.5 py-2.5 rounded-xl bg-[#282a36] border border-[#44475a] text-sm text-[#f8f8f2] placeholder-[#6272a4] focus:outline-none focus:border-[#bd93f9] focus:ring-1 focus:ring-[#bd93f9]/40 transition-colors';

  return (
    <div className="min-h-screen bg-[#282a36] text-[#f8f8f2] flex items-center justify-center p-4 relative overflow-hidden">
      {/* Dracula glow backdrop — same palette as the app shell */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute -top-40 -left-40 w-96 h-96 bg-[#bd93f9]/15 rounded-full blur-[140px]" />
        <div className="absolute top-1/3 -right-40 w-96 h-96 bg-[#ff79c6]/12 rounded-full blur-[140px]" />
        <div className="absolute -bottom-40 left-1/3 w-96 h-96 bg-[#8be9fd]/12 rounded-full blur-[140px]" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45, ease: 'easeOut' }}
        className="relative w-full max-w-md rounded-3xl border border-[#44475a] bg-[#21222c]/95 shadow-[0_28px_80px_rgba(0,0,0,0.5)] overflow-hidden"
      >
        {/* Header with Seren */}
        <div className="px-6 pt-6 pb-4 text-center border-b border-[#44475a]/70">
          <div className="w-32 h-32 mx-auto rounded-full overflow-hidden border-2 border-[#bd93f9]/70 bg-[#282a36] shadow-lg shadow-[#bd93f9]/20">
            <img src={SEREN_PROFILE_IMAGE} alt="Seren" className="w-full h-full object-cover" />
          </div>
          <h1 className="mt-3 text-xl font-extrabold tracking-tight">
            Welcome to <span className="text-[#bd93f9]">Seren</span>
          </h1>
          <p className="mt-1 text-xs text-[#6272a4] leading-relaxed">
            Sign in to save every lesson, report and transcript — and pick up
            exactly where you left off on any device.
          </p>
        </div>

        <div className="px-6 py-5 space-y-3">
          {/* Method switch — the learner picks how they want to sign in. */}
          <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-[#282a36] border border-[#44475a]">
            <button
              id="auth-tab-google"
              type="button"
              onClick={() => {
                setMode('google');
                setError(null);
                setNotice(null);
              }}
              className={`py-2 rounded-lg text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 ${
                mode === 'google'
                  ? 'bg-[#bd93f9] text-[#282a36] font-bold'
                  : 'text-[#6272a4] hover:text-[#f8f8f2]'
              }`}
            >
              <GoogleMark /> Google
            </button>
            <button
              id="auth-tab-email"
              type="button"
              onClick={() => {
                setMode('email');
                setError(null);
                setNotice(null);
              }}
              className={`py-2 rounded-lg text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 ${
                mode === 'email'
                  ? 'bg-[#bd93f9] text-[#282a36] font-bold'
                  : 'text-[#6272a4] hover:text-[#f8f8f2]'
              }`}
            >
              <Mail className="w-3.5 h-3.5" /> Email
            </button>
          </div>

          {mode === 'google' ? (
            <button
              id="google-signin-btn"
              type="button"
              onClick={handleGoogleSignIn}
              disabled={busy || !cloudAvailable}
              className="w-full py-3 rounded-xl bg-white text-[#282a36] text-sm font-extrabold hover:bg-[#f1f1f1] disabled:opacity-40 disabled:pointer-events-none transition-all shadow-lg shadow-black/20 flex items-center justify-center gap-2.5"
            >
              {busy ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Signing in…
                </>
              ) : (
                <>
                  <GoogleMark /> Continue with Google
                </>
              )}
            </button>
          ) : (
            <div className="space-y-3">
              <div>
                <label
                  htmlFor="auth-email"
                  className="block text-[11px] font-semibold uppercase tracking-wider text-[#8be9fd] mb-1.5"
                >
                  Email
                </label>
                <input
                  id="auth-email"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !busy) void handleEmailAuth();
                  }}
                  disabled={busy || !cloudAvailable}
                  className={inputClass}
                />
              </div>

              <div>
                <label
                  htmlFor="auth-password"
                  className="block text-[11px] font-semibold uppercase tracking-wider text-[#8be9fd] mb-1.5"
                >
                  Password
                </label>
                <div className="relative">
                  <input
                    id="auth-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete={emailAction === 'create' ? 'new-password' : 'current-password'}
                    placeholder={emailAction === 'create' ? 'At least 8 characters' : 'Your password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !busy) void handleEmailAuth();
                    }}
                    disabled={busy || !cloudAvailable}
                    className={`${inputClass} pr-11`}
                  />
                  <button
                    id="auth-toggle-password"
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-[#6272a4] hover:text-[#f8f8f2] hover:bg-[#44475a] transition-colors"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <button
                id="email-signin-btn"
                type="button"
                onClick={handleEmailAuth}
                disabled={busy || !cloudAvailable}
                className="w-full py-3 rounded-xl bg-[#bd93f9] hover:bg-[#bd93f9]/90 text-[#282a36] text-sm font-extrabold disabled:opacity-40 disabled:pointer-events-none transition-all shadow-lg shadow-[#bd93f9]/25 flex items-center justify-center gap-2.5"
              >
                {busy ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" /> Working…
                  </>
                ) : emailAction === 'create' ? (
                  <>
                    <UserPlus className="w-4 h-4" /> Create account
                  </>
                ) : (
                  <>
                    <LogIn className="w-4 h-4" /> Sign in
                  </>
                )}
              </button>

              <div className="flex items-center justify-between text-[11px]">
                <button
                  id="auth-toggle-action"
                  type="button"
                  onClick={() => {
                    setEmailAction((a) => (a === 'signin' ? 'create' : 'signin'));
                    setError(null);
                    setNotice(null);
                  }}
                  className="text-[#8be9fd] hover:text-[#f8f8f2] font-medium transition-colors"
                >
                  {emailAction === 'signin' ? 'Need an account? Create one' : 'Already have an account? Sign in'}
                </button>
                {emailAction === 'signin' && (
                  <button
                    id="auth-forgot-password"
                    type="button"
                    onClick={handleForgotPassword}
                    disabled={busy || !cloudAvailable}
                    className="text-[#6272a4] hover:text-[#f8f8f2] transition-colors disabled:opacity-50"
                  >
                    Forgot password?
                  </button>
                )}
              </div>
            </div>
          )}

          {error && (
            <motion.p
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-start gap-1.5 text-[11px] text-[#ff5555] bg-[#ff5555]/10 border border-[#ff5555]/30 rounded-lg px-2.5 py-2"
            >
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
              {error}
            </motion.p>
          )}

          {notice && (
            <motion.p
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-start gap-1.5 text-[11px] text-[#50fa7b] bg-[#50fa7b]/10 border border-[#50fa7b]/30 rounded-lg px-2.5 py-2"
            >
              <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-px" />
              {notice}
            </motion.p>
          )}

          {!cloudAvailable && (
            <div className="flex items-start gap-1.5 text-[11px] text-[#ffb86c] bg-[#ffb86c]/10 border border-[#ffb86c]/30 rounded-lg px-2.5 py-2">
              <CloudOff className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span>
                Cloud sync isn’t configured in this build. You can still use Seren — progress
                just stays on this device.
              </span>
            </div>
          )}

          {!cloudAvailable && (
            <button
              type="button"
              onClick={handleContinueOffline}
              className="w-full py-2.5 rounded-xl bg-[#282a36] border border-[#44475a] text-[#f8f8f2] text-sm font-bold hover:bg-[#2f303d] hover:border-[#6272a4] transition-all flex items-center justify-center gap-2"
            >
              <LogIn className="w-4 h-4" /> Continue without an account
            </button>
          )}
        </div>

        <div className="px-6 pb-5 pt-1 space-y-2">
          <p className="flex items-start gap-1.5 text-[10px] text-[#6272a4] leading-relaxed">
            <ShieldCheck className="w-3.5 h-3.5 shrink-0 text-[#50fa7b] mt-px" />
            Seren never sees your Google or email password — Firebase handles
            sign-in, and your progress is stored under your account only.
          </p>
          <p className="flex items-start gap-1.5 text-[10px] text-[#6272a4] leading-relaxed">
            <Sparkles className="w-3.5 h-3.5 shrink-0 text-[#ffb86c] mt-px" />
            Already practising here? Signing in uploads what’s on this device first, then
            merges with the cloud.
          </p>
        </div>
      </motion.div>
    </div>
  );
};
