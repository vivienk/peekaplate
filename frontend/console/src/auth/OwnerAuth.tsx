// S4-FE-04: owner account access. E1 Enter email, S01 Create account and S02 Sign in (Figma
// l7A9n8tACJic0FIhY49Zjw, nodes 1912:9859, 1447:10910, 1918:9980), and password recovery: S03 Forgot
// password and S04 Reset password (S03/S04 handoff). Every provider call goes through
// OwnerAuthService; these screens only react to its results.
import { type FormEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { TextField } from '../foundations/TextField';
import { Button } from '../ui';
import logo from './assets/logo.png';
import type { OwnerAuthService, RateLimited } from './auth-service';
import {
  BANNERS,
  type BannerCopy,
  emailError,
  fullNameError,
  newPasswordError,
  rateLimitedBanner,
  resetPasswordError,
  signInPasswordError,
  TERMS_ERROR,
} from './copy';
import {
  BackLink,
  DoneMark,
  EmailField,
  ErrorBanner,
  ErrorMark,
  LockedEmailField,
  MailIllustration,
  OrDivider,
  PasswordField,
  ResendGroup,
  StatusPanel,
  SubmitButton,
} from './parts';
import './auth.css';

export type AuthStep =
  | 'email'
  | 'create'
  | 'signin'
  | 'confirm-email'
  // S03 Forgot password, then S03 Check email.
  | 'forgot'
  | 'forgot-sent'
  // S04, opened from the reset email: the form, Password updated, and This reset link can't be used.
  | 'reset'
  | 'reset-done'
  | 'reset-signout-pending'
  | 'reset-invalid';

// Result screens show no logo (Figma "Check your email", "Password updated", "link can't be used").
const WITHOUT_BRAND: readonly AuthStep[] = [
  'confirm-email',
  'forgot-sent',
  'reset-done',
  'reset-signout-pending',
  'reset-invalid',
];

export type OwnerAuthProps = {
  service: OwnerAuthService;
  // A real sign-in succeeded. The caller opens the owner's next setup step or the dashboard.
  onSignedIn: () => void;
  // The provider created an account that needs no email confirmation. The caller opens the first
  // setup step. When confirmation is required the screens show "Check your email" instead.
  onAccountCreated: () => void;
  // 'reset' when the owner arrives from the reset email; 'reset-invalid' when the caller already
  // knows the link cannot be used (the S04 handoff proposes checking it when the page opens).
  initialStep?: AuthStep;
  initialEmail?: string;
};

export function OwnerAuth({
  service,
  onSignedIn,
  onAccountCreated,
  initialStep = 'email',
  initialEmail = '',
}: OwnerAuthProps) {
  const [step, setStep] = useState<AuthStep>(initialStep);
  const [email, setEmail] = useState(initialEmail);
  // Focus moves to the new screen's heading only after the owner moves between screens, never on
  // first load.
  const [moved, setMoved] = useState(false);
  // How long "Resend email" waits after a reset link is sent, if the service said.
  const [resendWait, setResendWait] = useState<number>();

  const go = (next: AuthStep, nextEmail = email) => {
    setEmail(nextEmail);
    setStep(next);
    setMoved(true);
  };

  return (
    <div className="pp-auth">
      <div className={`pp-auth__card pp-auth__card--${step}`}>
        {!WITHOUT_BRAND.includes(step) && (
          <p className="pp-auth__brand">
            <img src={logo} alt="" width="32" height="32" />
            <span>PeekaPlate</span>
          </p>
        )}
        {step === 'email' && (
          <EmailStep
            key="email"
            email={email}
            focusHeading={moved}
            service={service}
            onRoute={go}
          />
        )}
        {step === 'create' && (
          <CreateStep
            key="create"
            email={email}
            focusHeading={moved}
            service={service}
            onRoute={go}
            onCreated={onAccountCreated}
          />
        )}
        {step === 'signin' && (
          <SignInStep
            key="signin"
            email={email}
            focusHeading={moved}
            service={service}
            onRoute={go}
            onSignedIn={onSignedIn}
          />
        )}
        {step === 'confirm-email' && (
          <ConfirmEmailStep
            key="confirm-email"
            email={email}
            focusHeading={moved}
            service={service}
            onRoute={go}
          />
        )}
        {step === 'forgot' && (
          <ForgotStep
            key="forgot"
            email={email}
            focusHeading={moved}
            service={service}
            onRoute={go}
            onSent={(address, wait) => {
              setResendWait(wait);
              go('forgot-sent', address);
            }}
          />
        )}
        {step === 'forgot-sent' && (
          <ForgotSentStep
            key="forgot-sent"
            email={email}
            focusHeading={moved}
            service={service}
            onRoute={go}
            resendAfterSeconds={resendWait}
          />
        )}
        {step === 'reset' && (
          <ResetStep
            key="reset"
            email={email}
            focusHeading={moved}
            service={service}
            onRoute={go}
          />
        )}
        {(step === 'reset-done' || step === 'reset-signout-pending') && (
          <ResetDoneStep
            key="reset-done"
            email={email}
            focusHeading={moved}
            onRoute={go}
            signOutPending={step === 'reset-signout-pending'}
          />
        )}
        {step === 'reset-invalid' && (
          <ResetInvalidStep key="reset-invalid" email={email} focusHeading={moved} onRoute={go} />
        )}
      </div>
    </div>
  );
}

type StepProps = {
  email: string;
  focusHeading: boolean;
  service: OwnerAuthService;
  onRoute: (step: AuthStep, email?: string) => void;
};

function useHeadingFocus(focus: boolean): RefObject<HTMLHeadingElement | null> {
  const heading = useRef<HTMLHeadingElement>(null);
  // Runs once, when the screen opens.
  useEffect(() => {
    if (focus) heading.current?.focus();
  }, []);
  return heading;
}

function StepHeader({
  heading,
  title,
  children,
}: {
  heading: RefObject<HTMLHeadingElement | null>;
  title: string;
  children: ReactNode;
}) {
  return (
    <header className="pp-auth__header">
      <h1 className="pp-auth__title" ref={heading} tabIndex={-1}>
        {title}
      </h1>
      <p className="pp-auth__lead">{children}</p>
    </header>
  );
}

// Runs one provider call at a time. A thrown error counts as a failure the owner can retry.
function useRequest() {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  async function run<T>(call: () => Promise<T>, failed: T): Promise<T | undefined> {
    if (running.current) return undefined;
    running.current = true;
    setBusy(true);
    try {
      return await call();
    } catch {
      return failed;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return { busy, run, running };
}

// Keeps an action blocked while the service asks the owner to wait (rate limited). Without a wait
// from the service nothing is blocked; the banner says to try again later.
function useCooldown() {
  const [until, setUntil] = useState<number | null>(null);
  useEffect(() => {
    if (until === null) return;
    const timer = setTimeout(() => setUntil(null), Math.max(0, until - Date.now()));
    return () => clearTimeout(timer);
  }, [until]);
  return {
    blocked: until !== null,
    start(limit: RateLimited) {
      if (limit.retryAfterSeconds && limit.retryAfterSeconds > 0) {
        setUntil(Date.now() + limit.retryAfterSeconds * 1000);
      }
    },
  };
}

// E1: the owner's work email decides the next step.
function EmailStep({ email, focusHeading, service, onRoute }: StepProps) {
  const heading = useHeadingFocus(focusHeading);
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(email);
  const [error, setError] = useState<string>();
  const [banner, setBanner] = useState<BannerCopy | null>(null);
  const { busy, run, running } = useRequest();
  const cooldown = useCooldown();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (running.current || cooldown.blocked) return;
    const problem = emailError(value);
    setError(problem);
    if (problem) {
      input.current?.focus();
      return;
    }
    const address = value.trim();
    setBanner(null);
    const result = await run(() => service.checkEmail(address), { kind: 'failed' as const });
    if (!result) return;
    if (result.kind === 'existing_account' || result.kind === 'continue_to_sign_in')
      onRoute('signin', address);
    else if (result.kind === 'new_account') onRoute('create', address);
    else if (result.kind === 'rate_limited') {
      cooldown.start(result);
      setBanner(rateLimitedBanner(result.retryAfterSeconds));
    } else setBanner(result.kind === 'unavailable' ? BANNERS.unavailable : BANNERS.continueFailed);
  }

  return (
    <>
      <StepHeader heading={heading} title="Welcome to PeekaPlate">
        Enter your work email to get started. We’ll take you to the right next step.
      </StepHeader>
      {banner && <ErrorBanner copy={banner} />}
      <form className="pp-auth__form" noValidate onSubmit={submit}>
        <EmailField
          label="Email address"
          value={value}
          inputRef={input}
          readOnly={busy}
          {...(error ? { error } : {})}
          onChange={(next) => {
            setValue(next);
            setError(undefined);
          }}
        />
        <SubmitButton
          busy={busy}
          blocked={cooldown.blocked}
          label="Continue"
          busyLabel="Checking…"
        />
      </form>
      <p className="pp-auth__footer">
        New to PeekaPlate? You’ll set up your account on the next step
      </p>
    </>
  );
}

type CreateErrors = {
  fullName?: string | undefined;
  password?: string | undefined;
  terms?: string | undefined;
};

// S01: account creation for an email without an account.
function CreateStep({
  email,
  focusHeading,
  service,
  onRoute,
  onCreated,
}: StepProps & { onCreated: () => void }) {
  const heading = useHeadingFocus(focusHeading);
  const nameInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const termsInput = useRef<HTMLInputElement>(null);
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [terms, setTerms] = useState(false);
  const [errors, setErrors] = useState<CreateErrors>({});
  const [banner, setBanner] = useState<'failed' | 'exists' | 'unavailable' | BannerCopy | null>(
    null,
  );
  const { busy, run, running } = useRequest();
  const cooldown = useCooldown();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (running.current || cooldown.blocked) return;
    const found: CreateErrors = {
      fullName: fullNameError(fullName),
      password: newPasswordError(password),
      terms: terms ? undefined : TERMS_ERROR,
    };
    setErrors(found);
    const first = found.fullName
      ? nameInput
      : found.password
        ? passwordInput
        : found.terms
          ? termsInput
          : null;
    if (first) {
      first.current?.focus();
      return;
    }
    setBanner(null);
    const result = await run(
      () =>
        service.createAccount({ fullName: fullName.trim(), email, password, acceptedTerms: true }),
      { kind: 'failed' as const },
    );
    if (!result) return;
    if (result.kind === 'created') onCreated();
    else if (result.kind === 'confirmation_required') onRoute('confirm-email');
    else if (result.kind === 'weak_password') setBanner(BANNERS.weakPassword);
    else if (result.kind === 'account_exists') setBanner('exists');
    else if (result.kind === 'rate_limited') {
      cooldown.start(result);
      setBanner(rateLimitedBanner(result.retryAfterSeconds));
    } else setBanner(result.kind);
  }

  const termsErrorId = 'pp-auth-terms-error';

  return (
    <>
      <StepHeader heading={heading} title="Create your account">
        Set up your menu and see how diners respond to your dishes.
      </StepHeader>
      {banner === 'exists' && (
        <ErrorBanner
          copy={BANNERS.accountExists}
          action={
            <button
              type="button"
              className="pp-auth-link pp-auth-banner__action"
              onClick={() => onRoute('signin')}
            >
              Sign in instead
            </button>
          }
        />
      )}
      {banner === 'failed' && <ErrorBanner copy={BANNERS.createFailed} />}
      {banner === 'unavailable' && <ErrorBanner copy={BANNERS.unavailable} />}
      {typeof banner === 'object' && banner !== null && <ErrorBanner copy={banner} />}
      <form className="pp-auth__form" noValidate onSubmit={submit}>
        <TextField
          ref={nameInput}
          label="Full name"
          name="name"
          autoComplete="name"
          placeholder="Your full name"
          value={fullName}
          readOnly={busy}
          {...(errors.fullName ? { error: errors.fullName } : {})}
          onChange={(event) => {
            setFullName(event.target.value);
            setErrors((current) => ({ ...current, fullName: undefined }));
          }}
        />
        <LockedEmailField
          label="Email address"
          email={email}
          disabled={busy}
          onChange={() => onRoute('email')}
        />
        <PasswordField
          label="Password"
          value={password}
          inputRef={passwordInput}
          autoComplete="new-password"
          placeholder="Create a password"
          hint="Use at least 8 characters"
          readOnly={busy}
          {...(errors.password ? { error: errors.password } : {})}
          onChange={(next) => {
            setPassword(next);
            setErrors((current) => ({ ...current, password: undefined }));
          }}
        />
        <div className="pp-auth-terms">
          <div className="pp-auth-terms__row">
            <input
              ref={termsInput}
              id="pp-auth-terms"
              className="pp-auth-terms__box"
              type="checkbox"
              checked={terms}
              aria-invalid={errors.terms ? true : undefined}
              aria-describedby={errors.terms ? termsErrorId : undefined}
              onChange={(event) => {
                if (busy) return;
                setTerms(event.target.checked);
                setErrors((current) => ({ ...current, terms: undefined }));
              }}
            />
            <label className="pp-auth-terms__label" htmlFor="pp-auth-terms">
              I agree to the Terms of Service and Privacy Policy, and confirm I’m authorized to
              manage this restaurant.
            </label>
          </div>
          {errors.terms && (
            <p className="pp-field__error pp-auth-terms__error" id={termsErrorId}>
              <span className="pp-visually-hidden">Error: </span>
              {errors.terms}
            </p>
          )}
        </div>
        <SubmitButton
          busy={busy}
          blocked={cooldown.blocked}
          label="Create account"
          busyLabel="Creating account…"
        />
      </form>
      <p className="pp-auth__footer">
        Already have an account?{' '}
        <button
          type="button"
          className="pp-auth-link"
          disabled={busy}
          onClick={() => onRoute('signin')}
        >
          Sign in
        </button>
      </p>
    </>
  );
}

// S02: sign in for an email with an account (S02 handoff, sections 1-7).
function SignInStep({
  email,
  focusHeading,
  service,
  onRoute,
  onSignedIn,
}: StepProps & { onSignedIn: () => void }) {
  const heading = useHeadingFocus(focusHeading);
  const passwordInput = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [banner, setBanner] = useState<BannerCopy | null>(null);
  const { busy, run, running } = useRequest();
  const cooldown = useCooldown();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (running.current || cooldown.blocked) return;
    const problem = signInPasswordError(password);
    setError(problem);
    if (problem) {
      passwordInput.current?.focus();
      return;
    }
    // The banner is removed when the new request starts (S02 handoff, sections 2 and 3).
    setBanner(null);
    const result = await run(() => service.signIn({ email, password }), {
      kind: 'failed' as const,
    });
    if (!result) return;
    if (result.kind === 'signed_in') {
      onSignedIn();
    } else if (result.kind === 'invalid_credentials') {
      // The email is kept and the password cleared for the next attempt (PROPOSED in the handoff).
      setBanner(BANNERS.invalidCredentials);
      setPassword('');
      passwordInput.current?.focus();
    } else if (result.kind === 'email_not_confirmed') {
      setBanner(BANNERS.emailNotConfirmed);
    } else if (result.kind === 'rate_limited') {
      cooldown.start(result);
      setBanner(rateLimitedBanner(result.retryAfterSeconds));
    } else {
      // A temporary failure keeps both fields so the same details can be sent again.
      setBanner(result.kind === 'unavailable' ? BANNERS.unavailable : BANNERS.signInFailed);
    }
  }

  return (
    <>
      <StepHeader heading={heading} title="Welcome back">
        Enter your password to sign in.
      </StepHeader>
      {banner && <ErrorBanner copy={banner} />}
      <form className="pp-auth__form" noValidate onSubmit={submit}>
        <LockedEmailField
          label="Email"
          email={email}
          disabled={busy}
          onChange={() => onRoute('email')}
        />
        <div className="pp-auth__password">
          <PasswordField
            label="Password"
            value={password}
            inputRef={passwordInput}
            autoComplete="current-password"
            placeholder="Enter your password"
            readOnly={busy}
            {...(error ? { error } : {})}
            onChange={(next) => {
              setPassword(next);
              setError(undefined);
            }}
          />
          <button
            type="button"
            className="pp-auth-link pp-auth__forgot"
            disabled={busy}
            onClick={() => onRoute('forgot')}
          >
            Forgot password?
          </button>
        </div>
        <SubmitButton
          busy={busy}
          blocked={cooldown.blocked}
          label="Sign in"
          busyLabel="Signing in…"
        />
      </form>
      <p className="pp-auth__footer">
        New to PeekaPlate?{' '}
        <button
          type="button"
          className="pp-auth-link pp-auth-link--accent"
          disabled={busy}
          onClick={() => onRoute('create')}
        >
          Create account
        </button>
      </p>
    </>
  );
}

// How long "Resend email" stays unavailable when the service does not say (S03 handoff, section 6:
// the wait is not decided yet).
const DEFAULT_RESEND_WAIT_SECONDS = 60;

// The line under Resend email: waiting, resent, or failed (S03 handoff, section 6).
function resendStatus(state: 'sent' | 'resent' | 'failed' | BannerCopy, blocked: boolean): string {
  if (typeof state === 'object') return `${state.title}. ${state.body}`;
  if (state === 'resent') return 'We’ve sent another link.';
  if (state === 'failed') return 'We couldn’t send another link. Please try again.';
  return blocked
    ? 'Resend is unavailable right now. Please wait before requesting another link.'
    : '';
}

// After Create account, when the provider sends a confirmation email (Sai, 11 Nov). Figma "Check your
// email" layout and Rania's wording (12 Nov): short, no address in the text, never says whether an
// account exists. Resend email shows only when the service can resend the confirmation.
function ConfirmEmailStep({ email, focusHeading, service, onRoute }: StepProps) {
  const heading = useHeadingFocus(focusHeading);
  const { busy, run, running } = useRequest();
  const cooldown = useCooldown();
  const [state, setState] = useState<'sent' | 'resent' | 'failed' | BannerCopy>('sent');
  const resendConfirmation = service.resendConfirmation?.bind(service);

  // The link was just sent, so Resend starts in its waiting state. Runs once, when the screen opens.
  useEffect(() => {
    cooldown.start({ kind: 'rate_limited', retryAfterSeconds: DEFAULT_RESEND_WAIT_SECONDS });
  }, []);

  async function resend() {
    if (!resendConfirmation || running.current || cooldown.blocked) return;
    const result = await run(() => resendConfirmation(email), { kind: 'failed' as const });
    if (!result) return;
    if (result.kind === 'sent') {
      setState('resent');
      cooldown.start({
        kind: 'rate_limited',
        retryAfterSeconds: result.resendAfterSeconds ?? DEFAULT_RESEND_WAIT_SECONDS,
      });
    } else if (result.kind === 'rate_limited') {
      setState(rateLimitedBanner(result.retryAfterSeconds));
      cooldown.start(result);
    } else {
      setState(result.kind === 'unavailable' ? BANNERS.unavailable : 'failed');
    }
  }

  return (
    <StatusPanel
      art={<MailIllustration />}
      title="Check your email"
      heading={heading}
      actions={
        <>
          {resendConfirmation && (
            <ResendGroup
              busy={busy}
              blocked={cooldown.blocked}
              status={resendStatus(state, cooldown.blocked)}
              onResend={resend}
            />
          )}
          <div className="pp-auth-status__links">
            {resendConfirmation && <OrDivider />}
            <button
              type="button"
              className="pp-auth-link pp-auth-link--accent"
              disabled={busy}
              onClick={() => onRoute('email')}
            >
              Edit email address
            </button>
            <BackLink disabled={busy} onClick={() => onRoute('signin')} />
          </div>
        </>
      }
    >
      We’ve sent a confirmation link to your email address. Check your inbox and spam folder to
      complete your account setup.
    </StatusPanel>
  );
}

// "Back to sign in" and "Sign in" open S02 when the email is known, otherwise Enter email (E1).
function signInStep(email: string): AuthStep {
  return email ? 'signin' : 'email';
}

// S03 Forgot password: Default, Validation error and Request failed (S03 handoff).
function ForgotStep({
  email,
  focusHeading,
  service,
  onRoute,
  onSent,
}: StepProps & { onSent: (email: string, resendAfterSeconds: number | undefined) => void }) {
  const heading = useHeadingFocus(focusHeading);
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(email);
  const [error, setError] = useState<string>();
  const [banner, setBanner] = useState<BannerCopy | null>(null);
  const [failed, setFailed] = useState(false);
  const { busy, run, running } = useRequest();
  const cooldown = useCooldown();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (running.current || cooldown.blocked) return;
    const problem = emailError(value);
    setError(problem);
    if (problem) {
      input.current?.focus();
      return;
    }
    const address = value.trim();
    setBanner(null);
    const result = await run(() => service.requestPasswordReset(address), {
      kind: 'failed' as const,
    });
    if (!result) return;
    if (result.kind === 'sent') {
      onSent(address, result.resendAfterSeconds);
      return;
    }
    if (result.kind === 'rate_limited') {
      cooldown.start(result);
      setBanner(rateLimitedBanner(result.retryAfterSeconds));
    } else {
      // The entered email is kept; "Try again" sends the same request (S03 handoff, section 5).
      setFailed(result.kind === 'failed');
      setBanner(result.kind === 'unavailable' ? BANNERS.unavailable : BANNERS.resetLinkFailed);
    }
  }

  return (
    <>
      <StepHeader heading={heading} title="Forgot password?">
        Enter the email address you use for PeekaPlate and we’ll send you a link to reset your
        password.
      </StepHeader>
      {banner && <ErrorBanner copy={banner} />}
      <form className="pp-auth__form" noValidate onSubmit={submit}>
        <EmailField
          label="Email address"
          value={value}
          inputRef={input}
          readOnly={busy}
          {...(error ? { error } : {})}
          onChange={(next) => {
            setValue(next);
            setError(undefined);
          }}
        />
        <SubmitButton
          busy={busy}
          blocked={cooldown.blocked}
          label={failed ? 'Try again' : 'Send reset link'}
          busyLabel="Sending…"
        />
      </form>
      <BackLink disabled={busy} onClick={() => onRoute(signInStep(email))} />
    </>
  );
}

// S03 Check email, with Resend email (available, waiting, resent), Edit email address and Back to
// sign in. The text never confirms that an account exists (S03 handoff, section 4).
function ForgotSentStep({
  email,
  focusHeading,
  service,
  onRoute,
  resendAfterSeconds,
}: StepProps & { resendAfterSeconds: number | undefined }) {
  const heading = useHeadingFocus(focusHeading);
  const { busy, run, running } = useRequest();
  const cooldown = useCooldown();
  const [status, setStatus] = useState<'sent' | 'resent' | 'failed' | BannerCopy>('sent');

  // The link was just sent, so Resend starts in its waiting state. Runs once, when the screen opens.
  useEffect(() => {
    cooldown.start({
      kind: 'rate_limited',
      retryAfterSeconds: resendAfterSeconds ?? DEFAULT_RESEND_WAIT_SECONDS,
    });
  }, []);

  async function resend() {
    if (running.current || cooldown.blocked) return;
    const result = await run(() => service.requestPasswordReset(email), {
      kind: 'failed' as const,
    });
    if (!result) return;
    if (result.kind === 'sent') {
      setStatus('resent');
      cooldown.start({
        kind: 'rate_limited',
        retryAfterSeconds: result.resendAfterSeconds ?? DEFAULT_RESEND_WAIT_SECONDS,
      });
    } else if (result.kind === 'rate_limited') {
      setStatus(rateLimitedBanner(result.retryAfterSeconds));
      cooldown.start(result);
    } else {
      setStatus(result.kind === 'unavailable' ? BANNERS.unavailable : 'failed');
    }
  }

  return (
    <StatusPanel
      art={<MailIllustration />}
      title="Check your email"
      heading={heading}
      actions={
        <>
          <ResendGroup
            busy={busy}
            blocked={cooldown.blocked}
            status={resendStatus(status, cooldown.blocked)}
            onResend={resend}
          />
          <div className="pp-auth-status__links">
            <OrDivider />
            <button
              type="button"
              className="pp-auth-link pp-auth-link--accent"
              disabled={busy}
              onClick={() => onRoute('forgot')}
            >
              Edit email address
            </button>
            <BackLink disabled={busy} onClick={() => onRoute(signInStep(email))} />
          </div>
        </>
      }
    >
      If an account exists for this email address, we’ll send a link to reset your password. Check
      your inbox and spam folder.
    </StatusPanel>
  );
}

// S04 Reset password: Default, Validation error and Request failed (S04 handoff).
function ResetStep({ email, focusHeading, service, onRoute }: StepProps) {
  const heading = useHeadingFocus(focusHeading);
  const passwordInput = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [banner, setBanner] = useState<BannerCopy | null>(null);
  const { busy, run, running } = useRequest();
  const cooldown = useCooldown();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (running.current || cooldown.blocked) return;
    const problem = resetPasswordError(password);
    setError(problem);
    if (problem) {
      passwordInput.current?.focus();
      return;
    }
    setBanner(null);
    const result = await run(() => service.resetPassword(password), { kind: 'failed' as const });
    if (!result) return;
    if (result.kind === 'updated')
      onRoute(
        result.signOutPending ? 'reset-signout-pending' : 'reset-done',
        result.email ?? email,
      );
    else if (result.kind === 'invalid_link') onRoute('reset-invalid');
    else if (result.kind === 'weak_password') setBanner(BANNERS.weakPassword);
    else if (result.kind === 'same_password')
      setBanner({
        title: 'Choose a different password',
        body: 'Your new password must differ from the current one.',
      });
    else if (result.kind === 'rate_limited') {
      cooldown.start(result);
      setBanner(rateLimitedBanner(result.retryAfterSeconds));
    } else {
      // Whether the password is kept after a failure is not decided (S04 handoff, section 6); it is
      // kept here so the same request can be sent again.
      setBanner(result.kind === 'unavailable' ? BANNERS.unavailable : BANNERS.resetFailed);
    }
  }

  return (
    <>
      <StepHeader heading={heading} title="Reset your password">
        Choose a new password for your PeekaPlate account.
      </StepHeader>
      {banner && <ErrorBanner copy={banner} />}
      <form className="pp-auth__form" noValidate onSubmit={submit}>
        <PasswordField
          label="New password"
          value={password}
          inputRef={passwordInput}
          autoComplete="new-password"
          placeholder="Enter your new password"
          hint="Choose a password that’s hard to guess."
          readOnly={busy}
          {...(error ? { error } : {})}
          onChange={(next) => {
            setPassword(next);
            setError(undefined);
          }}
        />
        <SubmitButton
          busy={busy}
          blocked={cooldown.blocked}
          label="Reset password"
          busyLabel="Resetting…"
        />
      </form>
      <BackLink disabled={busy} onClick={() => onRoute(signInStep(email))} />
    </>
  );
}

type ResultStepProps = {
  email: string;
  focusHeading: boolean;
  onRoute: (step: AuthStep, email?: string) => void;
};

// S04 Password updated. The owner is not signed in automatically; Sign in opens S02.
function ResetDoneStep({
  email,
  focusHeading,
  onRoute,
  signOutPending = false,
}: ResultStepProps & { signOutPending?: boolean }) {
  const heading = useHeadingFocus(focusHeading);
  return (
    <StatusPanel
      art={<DoneMark />}
      title="Password updated"
      heading={heading}
      actions={
        <Button
          className="pp-auth-btn pp-auth-btn--primary"
          onClick={() => onRoute(signInStep(email))}
        >
          Sign in
        </Button>
      }
    >
      Your password has been changed. Sign in with your new password.
      {signOutPending && (
        <span role="alert">
          {' '}
          We could not confirm server sign-out. Close this page, then sign in again.
        </span>
      )}
    </StatusPanel>
  );
}

// S04 Invalid or expired link: Request a new link opens S03.
function ResetInvalidStep({ email, focusHeading, onRoute }: ResultStepProps) {
  const heading = useHeadingFocus(focusHeading);
  return (
    <StatusPanel
      art={<ErrorMark />}
      title="This reset link can’t be used"
      heading={heading}
      actions={
        <div className="pp-auth-status__actions">
          <Button className="pp-auth-btn pp-auth-btn--primary" onClick={() => onRoute('forgot')}>
            Request a new link
          </Button>
          <BackLink onClick={() => onRoute(signInStep(email))} />
        </div>
      }
    >
      This link may have expired or be invalid. Request a new link to continue.
    </StatusPanel>
  );
}
