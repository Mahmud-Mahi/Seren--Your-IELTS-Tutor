/**
 * Auth regression harness — email & password sign-in.
 *
 * The Firebase error codes are the part that is easy to get wrong and
 * impossible for the learner to debug ("sign-in failed, please try again"
 * tells them nothing). These checks pin the mapping and the form rules.
 *
 * Run with: npm run test:auth
 */
import {
  mapEmailAuthErrorCode,
  validateEmailCredentials,
  EMAIL_PATTERN,
  MIN_PASSWORD_LENGTH,
  MIN_NEW_PASSWORD_LENGTH,
} from '../src/auth/session';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean) => {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}`);
  }
};

// --- error-code mapping ----------------------------------------------------
check('a wrong password is reported as invalid credentials', mapEmailAuthErrorCode('auth/invalid-credential') === 'invalid_credentials');
check('the legacy wrong-password code maps too', mapEmailAuthErrorCode('auth/wrong-password') === 'invalid_credentials');
check('an unknown user maps to invalid credentials', mapEmailAuthErrorCode('auth/user-not-found') === 'invalid_credentials');
check('a taken email is reported as existing', mapEmailAuthErrorCode('auth/email-already-in-use') === 'email_exists');
check('a Google-linked email is reported as existing', mapEmailAuthErrorCode('auth/account-exists-with-different-credential') === 'email_exists');
check('a malformed email is reported as invalid', mapEmailAuthErrorCode('auth/invalid-email') === 'invalid_email');
check('a short password is reported as weak', mapEmailAuthErrorCode('auth/weak-password') === 'weak_password');
check('a disabled provider is reported as not enabled', mapEmailAuthErrorCode('auth/operation-not-allowed') === 'provider_not_enabled');
check('rate limiting is reported', mapEmailAuthErrorCode('auth/too-many-requests') === 'too_many_requests');
check('a network failure is reported', mapEmailAuthErrorCode('auth/network-request-failed') === 'network');
check('an unknown code falls back safely', mapEmailAuthErrorCode('auth/something-new') === 'sign_in_failed');
check('an empty code falls back safely', mapEmailAuthErrorCode('') === 'sign_in_failed');

// --- form validation -------------------------------------------------------
check('a normal email passes the pattern', EMAIL_PATTERN.test('mahi@example.com'));
check('a plus-addressed email passes', EMAIL_PATTERN.test('mahi+seren@example.co.uk'));
check('an email without a domain fails', !EMAIL_PATTERN.test('mahi@'));
check('an email without a dot in the domain fails', !EMAIL_PATTERN.test('mahi@example'));
check('an email with a space fails', !EMAIL_PATTERN.test('mahi @example.com'));
check('a plain word is not an email', !EMAIL_PATTERN.test('mahi'));

check('an empty email is rejected', validateEmailCredentials('', 'longenough1', 'signin') === 'invalid_email');
check('a malformed email is rejected', validateEmailCredentials('not-an-email', 'longenough1', 'signin') === 'invalid_email');
check('a short password is rejected on sign-in', validateEmailCredentials('a@b.co', 'x'.repeat(MIN_PASSWORD_LENGTH - 1), 'signin') === 'weak_password');
check('the minimum sign-in password is accepted', validateEmailCredentials('a@b.co', 'x'.repeat(MIN_PASSWORD_LENGTH), 'signin') === null);
check('a short password is rejected on create', validateEmailCredentials('a@b.co', 'x'.repeat(MIN_NEW_PASSWORD_LENGTH - 1), 'create') === 'weak_password');
check('the minimum new password is accepted', validateEmailCredentials('a@b.co', 'x'.repeat(MIN_NEW_PASSWORD_LENGTH), 'create') === null);
check('a valid sign-in passes', validateEmailCredentials('mahi@example.com', 'correcthorse', 'signin') === null);
check('a valid create passes', validateEmailCredentials('mahi@example.com', 'correcthorsebattery', 'create') === null);

console.log('');
console.log(fail === 0 ? `ALL PASS (${pass} checks)` : `${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
