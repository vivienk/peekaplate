// S4-FE-04.1: owner account access. E1 Enter email, S01 Create account and S02 Sign in (Figma
// l7A9n8tACJic0FIhY49Zjw, nodes 1912:9859, 1447:10910, 1918:9980). Every provider call goes through
// OwnerAuthService; these screens only react to its results.
import { type FormEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { TextField } from '../foundations/TextField';
import logo from './assets/logo.png';
import type { OwnerAuthService, RateLimited } from './auth-service';
import {
  BANNERS,
  type BannerCopy,
  emailError,
  fullNameError,
  newPasswordError,
  rateLimitedBanner,
  signInPasswordError,
  TERMS_ERROR,
} from './copy';
import {
  BackLink,
  EmailField,
  ErrorBanner,
  LockedEmailField,
  MAIL_ILLUSTRATION,
  PasswordField,
  StatusPanel,
  SubmitButton,
} from './parts';
import './auth.css';

export type AuthStep = 'email' | 'create' | 'signin' | 'confirm-email';

// Result screens show no logo (Figma "Check your email").
const WITHOUT_BRAND: readonly AuthStep[] = ['confirm-email'];

export type OwnerAuthProps = {
  service: OwnerAuthService;
  // A real sign-in succeeded. The caller opens the owner's next setup step or the dashboard.
  onSignedIn: () => void;
  // The provider created an account that needs no email confirmation. The caller opens the first
  // setup step. When confirmation is required the screens show "Check your email" instead.
  onAccountCreated: () => void;
  // Opens password recovery (S03). Without it the "Forgot password?" link is not shown.
  onForgotPassword?: () => void;
  initialStep?: AuthStep;
  initialEmail?: string;
};

export function OwnerAuth({
  service,
  onSignedIn,
  onAccountCreated,
  onForgotPassword,
  initialStep = 'email',
  initialEmail = '',
}: OwnerAuthProps) {
  const [step, setStep] = useState<AuthStep>(initialStep);
  const [email, setEmail] = useState(initialEmail);
  // Focus moves to the new screen's heading only after the owner moves between screens, never on
  // first load.
  const [moved, setMoved] = useState(false);

  const go = (next: AuthStep, nextEmail = email) => {
    setEmail(nextEmail);
    setStep(next);
    setMoved(true);
  };

  return (
    <div className="pp-auth">
      {/* Left side of the Figma frames: the food photo goes here once it is exported (decorative). */}
      <div className="pp-auth__art" aria-hidden="true" />
      <div className="pp-auth__card">
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
            {...(onForgotPassword ? { onForgotPassword } : {})}
          />
        )}
        {step === 'confirm-email' && (
          <ConfirmEmailStep key="confirm-email" email={email} focusHeading={moved} onRoute={go} />
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
    if (result.kind === 'existing_account') onRoute('signin', address);
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
        New to PeekaPlate? You’ll set up your account on the next step.
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
          className="pp-auth-link pp-auth-link--strong"
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
  onForgotPassword,
}: StepProps & { onSignedIn: () => void; onForgotPassword?: () => void }) {
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
          {onForgotPassword && (
            <button
              type="button"
              className="pp-auth-link pp-auth__forgot"
              disabled={busy}
              onClick={onForgotPassword}
            >
              Forgot password?
            </button>
          )}
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
          className="pp-auth-link pp-auth-link--accent pp-auth-link--strong"
          disabled={busy}
          onClick={() => onRoute('create')}
        >
          Create account
        </button>
      </p>
    </>
  );
}

// After Create account, when the provider sends a confirmation email (Sai, 11 Nov). Uses the S03
// "Check your email" layout. The owner confirms from the email and returns to the app.
function ConfirmEmailStep({
  email,
  focusHeading,
  onRoute,
}: {
  email: string;
  focusHeading: boolean;
  onRoute: (step: AuthStep, email?: string) => void;
}) {
  const heading = useHeadingFocus(focusHeading);
  return (
    <StatusPanel
      art={MAIL_ILLUSTRATION}
      title="Check your email"
      heading={heading}
      actions={
        <>
          <button
            type="button"
            className="pp-auth-link pp-auth-link--accent"
            onClick={() => onRoute('email')}
          >
            Edit email address
          </button>
          <BackLink onClick={() => onRoute('signin')} />
        </>
      }
    >
      We sent a confirmation link to <strong>{email}</strong>. Open it to finish creating your
      account. Check your inbox and spam folder.
    </StatusPanel>
  );
}
