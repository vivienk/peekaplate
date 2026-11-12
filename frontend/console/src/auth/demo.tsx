// Preview-only demo of the owner sign-in screens (S4-FE-04.1), built only for PR previews like the
// foundations demo. A synthetic service answers with the outcome picked below, so reviewers can see
// every state. It sends nothing anywhere, keeps nothing, and never signs anyone in.
import { StrictMode, useId, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../style.css';
import type {
  CreateAccountResult,
  EmailCheckResult,
  OwnerAuthService,
  SignInResult,
} from './auth-service';
import { OwnerAuth } from './OwnerAuth';
import './demo.css';

const root = document.getElementById('root');
if (!root) throw new Error('Owner sign-in demo root element is missing');

const CHECK: Record<string, string> = {
  existing_account: 'Account exists → Sign in',
  new_account: 'No account → Create account',
  failed: 'Service failure',
  rate_limited: 'Too many attempts (wait 5 s)',
  unavailable: 'Not connected',
};
const SIGN_IN: Record<string, string> = {
  signed_in: 'Correct details',
  invalid_credentials: 'Wrong email or password',
  email_not_confirmed: 'Email not confirmed',
  failed: 'Service failure',
  rate_limited: 'Too many attempts (wait 5 s)',
  unavailable: 'Not connected',
};
const CREATE: Record<string, string> = {
  confirmation_required: 'Created, confirmation email sent',
  created: 'Created, no confirmation needed',
  account_exists: 'Account already exists',
  failed: 'Service failure',
  rate_limited: 'Too many attempts (wait 5 s)',
  unavailable: 'Not connected',
};

// Long enough to see the loading state.
const DELAY_MS = 900;
const wait = () => new Promise((resolve) => setTimeout(resolve, DELAY_MS));
// The wait the synthetic service asks for when it answers "too many attempts".
const RETRY_AFTER_SECONDS = 5;
const answer = (kind: string) =>
  kind === 'rate_limited' ? { kind, retryAfterSeconds: RETRY_AFTER_SECONDS } : { kind };

function Choice({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Record<string, string>;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="pp-auth-demo__choice">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {Object.entries(options).map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
}

function Demo() {
  const [check, setCheck] = useState('existing_account');
  const [signIn, setSignIn] = useState('invalid_credentials');
  const [create, setCreate] = useState('confirmation_required');
  const [done, setDone] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  const [requests, setRequests] = useState(0);
  const answers = useRef({ check, signIn, create });
  answers.current = { check, signIn, create };

  const service: OwnerAuthService = {
    async checkEmail() {
      setRequests((n) => n + 1);
      await wait();
      return answer(answers.current.check) as EmailCheckResult;
    },
    async signIn() {
      setRequests((n) => n + 1);
      await wait();
      return answer(answers.current.signIn) as SignInResult;
    },
    async createAccount() {
      setRequests((n) => n + 1);
      await wait();
      return answer(answers.current.create) as CreateAccountResult;
    },
    // Check your email: a resend always succeeds here and asks for the demo's short wait.
    async resendConfirmation() {
      setRequests((n) => n + 1);
      await wait();
      return { kind: 'sent', resendAfterSeconds: RETRY_AFTER_SECONDS };
    },
  };

  return (
    <>
      <aside className="pp-auth-demo" aria-label="Demo controls">
        <p className="pp-auth-demo__label">
          <strong>Synthetic demo.</strong> No real accounts: nothing you type is sent or kept, and
          nobody is signed in. Pick what the sign-in service answers.
        </p>
        <div className="pp-auth-demo__choices">
          <Choice label="Email check answer" options={CHECK} value={check} onChange={setCheck} />
          <Choice label="Sign in answer" options={SIGN_IN} value={signIn} onChange={setSignIn} />
          <Choice
            label="Create account answer"
            options={CREATE}
            value={create}
            onChange={setCreate}
          />
          <p className="pp-auth-demo__count">Requests sent: {requests}</p>
        </div>
      </aside>
      {done ? (
        <main className="pp-auth-demo__done">
          <h1>{done}</h1>
          <p>
            Demo only: nobody is signed in. In the product this opens the owner’s first unfinished
            setup step, or the dashboard once setup is complete.
          </p>
          <button
            type="button"
            onClick={() => {
              setDone(null);
              setRun((n) => n + 1);
            }}
          >
            Start again
          </button>
        </main>
      ) : (
        <main>
          <OwnerAuth
            key={run}
            service={service}
            onSignedIn={() => setDone('Sign-in accepted (demo)')}
            onAccountCreated={() => setDone('Account created (demo)')}
            onForgotPassword={() => window.alert('Password recovery (S03) is not built yet.')}
          />
        </main>
      )}
    </>
  );
}

createRoot(root).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
