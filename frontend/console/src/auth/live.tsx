import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../style.css';
import { OwnerWorkspace } from '../owner/OwnerWorkspace';
import { readWorkspaceApiBase } from '../owner/workspace-api';
import { readConfirmationCode } from './callback';
import { OwnerAuth } from './OwnerAuth';
import {
  connectOwnerAuth,
  type OwnerAuthRuntime,
  readOwnerAuthConfig,
  type SignedInOwner,
} from './supabase-auth';

const isConfirmation = window.location.pathname === '/auth-confirm.html';
const isRecovery = window.location.pathname === '/auth-reset.html';
const isCallback = isConfirmation || isRecovery;
let confirmationCode = isCallback
  ? readConfirmationCode(window.location.href, isRecovery ? 'recovery' : 'confirmation')
  : null;
// No query-controlled redirects. Callback code stays in this tab's memory, never rendered/stored.
if (window.location.search || window.location.hash)
  window.history.replaceState(null, '', window.location.pathname);
const config = readOwnerAuthConfig(import.meta.env, window.location.origin);
const runtime = config ? connectOwnerAuth(config) : null;
const apiBase = readWorkspaceApiBase(import.meta.env.VITE_PUBLIC_API_URL);

function LiveOwnerAuth({ auth }: { auth: OwnerAuthRuntime }) {
  const [owner, setOwner] = useState<SignedInOwner | null>(null);
  const [message, setMessage] = useState('');
  const [callbackState, setCallbackState] = useState(
    isCallback ? (confirmationCode ? 'ready' : 'invalid') : 'none',
  );
  const [recoveryEmail, setRecoveryEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!isCallback);
  const identityGeneration = useRef(0);
  const refreshOwner = useCallback(async () => {
    const generation = ++identityGeneration.current;
    setOwner(null);
    setLoading(true);
    try {
      const current = await auth.signedInOwner();
      if (generation === identityGeneration.current) {
        setOwner(current);
        if (current) setMessage('');
      }
    } catch {
      if (generation === identityGeneration.current) setOwner(null);
    } finally {
      if (generation === identityGeneration.current) setLoading(false);
    }
  }, [auth]);
  const sessionExpired = useCallback(() => {
    identityGeneration.current++;
    setOwner(null);
    setLoading(false);
    setMessage('Your session could not be verified. Please sign in again.');
  }, []);
  const signOut = useCallback(async () => {
    setBusy(true);
    if (await auth.signOut()) {
      identityGeneration.current++;
      setOwner(null);
      setLoading(false);
    } else setMessage('Sign-out could not be confirmed. Try again.');
    setBusy(false);
  }, [auth]);

  useEffect(() => {
    function rejectChangedCallback() {
      confirmationCode = null;
      window.history.replaceState(null, '', window.location.pathname);
      if (isCallback) setCallbackState('invalid');
    }
    window.addEventListener('hashchange', rejectChangedCallback);
    window.addEventListener('popstate', rejectChangedCallback);
    return () => {
      window.removeEventListener('hashchange', rejectChangedCallback);
      window.removeEventListener('popstate', rejectChangedCallback);
    };
  }, []);

  useEffect(() => {
    const restore = !isCallback || callbackState === 'none';
    const unsubscribe = auth.onSessionChange(() => {
      identityGeneration.current++;
      setOwner(null);
      if (restore) void refreshOwner();
    });
    if (restore) void refreshOwner();
    return () => {
      identityGeneration.current++;
      unsubscribe();
    };
  }, [auth, callbackState, refreshOwner]);

  async function signedIn() {
    await refreshOwner();
    setCallbackState('none');
  }

  if (isRecovery && (callbackState === 'recovery' || callbackState === 'invalid'))
    return (
      <OwnerAuth
        service={auth.service}
        onSignedIn={signedIn}
        onAccountCreated={signedIn}
        initialStep={callbackState === 'recovery' ? 'reset' : 'reset-invalid'}
        initialEmail={recoveryEmail}
        key={callbackState}
      />
    );

  if (callbackState !== 'none')
    return (
      <main>
        <h1>
          {callbackState === 'confirmed'
            ? 'Email confirmed'
            : callbackState === 'invalid'
              ? 'This confirmation link cannot be used'
              : isRecovery
                ? 'Open password reset'
                : 'Confirm your email'}
        </h1>
        <p>
          {callbackState === 'invalid'
            ? 'Use the newest email in the same browser where you registered, or return to sign in.'
            : callbackState === 'confirmed'
              ? 'Your email is confirmed. Sign in to continue.'
              : isRecovery
                ? 'Select Continue to verify the newest recovery link before choosing a password.'
                : 'Select Continue to finish confirming your email. This does not grant access to a restaurant.'}
        </p>
        {callbackState === 'ready' && (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              if (busy) return;
              setBusy(true);
              const code = confirmationCode;
              confirmationCode = null;
              if (isRecovery) {
                const result = await auth.openRecovery(code ?? '');
                if (result.kind === 'ready') {
                  setRecoveryEmail(result.email);
                  setCallbackState('recovery');
                } else setCallbackState('invalid');
              } else {
                const result = await auth.confirmEmail(code ?? '');
                setCallbackState(result.kind === 'confirmed' ? 'confirmed' : 'invalid');
              }
              setBusy(false);
            }}
          >
            {busy ? 'Confirming…' : 'Continue'}
          </button>
        )}
        <p>
          <a href="/owner-auth.html">Back to sign in</a>
        </p>
      </main>
    );

  if (loading)
    return (
      <main>
        <p role="status">Checking your session…</p>
      </main>
    );

  if (owner)
    return (
      <>
        <OwnerWorkspace
          key={owner.id}
          auth={auth}
          owner={owner}
          apiBase={apiBase}
          onSessionExpired={sessionExpired}
          onSignOut={() => {
            void signOut();
          }}
          signingOut={busy}
        />
        {message && <p role="alert">{message}</p>}
      </>
    );

  return (
    <>
      {message && <p role="alert">{message}</p>}
      <OwnerAuth service={auth.service} onSignedIn={signedIn} onAccountCreated={signedIn} />
    </>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Owner auth root is missing');
createRoot(root).render(
  runtime ? (
    <LiveOwnerAuth auth={runtime} />
  ) : (
    <main>
      <h1>Owner sign-in is unavailable here</h1>
      <p>
        This build has no enabled owner-auth connection. PR preview demos never accept real
        credentials.
      </p>
    </main>
  ),
);
