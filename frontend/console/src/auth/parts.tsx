// S4-FE-04: the pieces the owner sign-in screens share, following the Figma components (Input /
// Text, Input / Password, Owner dashboard_Button, Error Message, Text link). Fields keep the TextField
// structure (label above, one hint or error below, linked with aria-describedby). Icons and the
// envelope are the Figma exports in ./assets.
import { type ReactNode, type Ref, useId, useState } from 'react';
import { Button, Input } from '../ui';
import arrowLeft from './assets/arrow-left.svg';
import badge from './assets/badge.svg';
import envelopeLineArt from './assets/envelope-line-art.svg';
import errorIcon from './assets/error.svg';
import eyeOpen from './assets/eye.svg';
import eyeOff from './assets/eye-off.svg';
import type { BannerCopy } from './copy';
import '../foundations/field.css';

function describe(id: string, hint?: string, error?: string) {
  const hintId = hint && !error ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return { hintId, errorId, describedBy: errorId ?? hintId };
}

function FieldNote({
  id,
  hint,
  error,
}: {
  id?: string | undefined;
  hint?: string | undefined;
  error?: string | undefined;
}) {
  if (error) {
    return (
      <p className="pp-field__error" id={id}>
        <span className="pp-visually-hidden">Error: </span>
        {error}
      </p>
    );
  }
  return hint ? (
    <p className="pp-field__hint" id={id}>
      {hint}
    </p>
  ) : null;
}

// Password-Eye Icon: open eye while the password is shown, crossed-out eye while it is hidden
// (Rania, 12 Nov).
function EyeIcon({ shown }: { shown: boolean }) {
  return (
    <span className="pp-auth-field__eye" data-eye={shown ? 'open' : 'closed'} aria-hidden="true">
      {shown ? (
        <img src={eyeOpen} alt="" width="20" height="15.5693" />
      ) : (
        <img src={eyeOff} alt="" width="20" height="20" />
      )}
    </span>
  );
}

type PasswordFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  placeholder: string;
  hint?: string;
  error?: string;
  readOnly?: boolean;
  inputRef?: Ref<HTMLInputElement>;
};

// Password with a show/hide control (S02 handoff, section 5). The typed value is kept when toggling,
// and the control's name says what pressing it does.
export function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  placeholder,
  hint,
  error,
  readOnly,
  inputRef,
}: PasswordFieldProps) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const { hintId, errorId, describedBy } = describe(id, hint, error);
  return (
    <div className="pp-field">
      <label className="pp-field__label" htmlFor={id}>
        {label}
      </label>
      <div className="pp-auth-field__box">
        <Input
          {...(inputRef ? { ref: inputRef } : {})}
          id={id}
          name="password"
          type={visible ? 'text' : 'password'}
          className="pp-field__control pp-auth-field__input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          placeholder={placeholder}
          readOnly={readOnly}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          spellCheck={false}
          autoCapitalize="none"
        />
        <button
          type="button"
          className="pp-auth-field__toggle"
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-controls={id}
          onClick={() => setVisible((shown) => !shown)}
        >
          <EyeIcon shown={visible} />
        </button>
      </div>
      <FieldNote id={errorId ?? hintId} hint={hint} error={error} />
    </div>
  );
}

type EmailFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  readOnly?: boolean;
  inputRef?: Ref<HTMLInputElement>;
};

export function EmailField({ label, value, onChange, error, readOnly, inputRef }: EmailFieldProps) {
  const id = useId();
  const { errorId, describedBy } = describe(id, undefined, error);
  return (
    <div className="pp-field">
      <label className="pp-field__label" htmlFor={id}>
        {label}
      </label>
      <Input
        {...(inputRef ? { ref: inputRef } : {})}
        id={id}
        name="email"
        type="email"
        inputMode="email"
        autoComplete="email"
        spellCheck={false}
        autoCapitalize="none"
        className="pp-field__control"
        placeholder="you@restaurant.com"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        readOnly={readOnly}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
      />
      <FieldNote id={errorId} error={error} />
    </div>
  );
}

// The email chosen on the first screen, shown read-only with "Change" (back to Enter email). It is
// a real read-only input so password managers pair the saved password with this email.
export function LockedEmailField({
  label,
  email,
  onChange,
  disabled,
}: {
  label: string;
  email: string;
  onChange: () => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="pp-field">
      <label className="pp-field__label" htmlFor={id}>
        {label}
      </label>
      <div className="pp-auth-field__box pp-auth-field__box--locked">
        <Input
          id={id}
          name="email"
          type="email"
          autoComplete="username"
          className="pp-field__control pp-auth-field__input pp-auth-field__locked"
          value={email}
          readOnly
        />
        <button
          type="button"
          className="pp-auth-link pp-auth-link--accent pp-auth-field__change"
          aria-label="Change email address"
          onClick={onChange}
          disabled={disabled}
        >
          Change
        </button>
      </div>
    </div>
  );
}

// A recoverable error above the form (Error Message component). role="alert" announces it when it
// appears; the text is always shown, so colour is never the only signal.
// icon: the error msg component's icon variant; the warning circle unless the screen picks another.
export function ErrorBanner({
  copy,
  action,
  icon = errorIcon,
}: {
  copy: BannerCopy;
  action?: ReactNode;
  icon?: string;
}) {
  return (
    <div className="pp-auth-banner" role="alert">
      <span className="pp-auth-banner__icon" aria-hidden="true">
        <img src={icon} alt="" width="24" height="24" />
      </span>
      <div className="pp-auth-banner__text">
        <p className="pp-auth-banner__title">{copy.title}</p>
        {copy.body && <p className="pp-auth-banner__body">{copy.body}</p>}
        {action}
      </div>
    </div>
  );
}

// Owner dashboard_Button, size Large, full width. While a request runs it shows a spinner and a
// "…ing" label and ignores presses; it is not disabled, so keyboard focus stays on it (S02 handoff,
// section 4). While the service asks the owner to wait (rate limited) it shows the Disabled look but
// stays focusable.
export function SubmitButton({
  busy,
  label,
  busyLabel,
  blocked = false,
}: {
  busy: boolean;
  label: string;
  busyLabel: string;
  blocked?: boolean;
}) {
  return (
    <Button
      type="submit"
      className="pp-auth__submit pp-auth-btn pp-auth-btn--primary"
      aria-busy={busy ? true : undefined}
      aria-disabled={blocked && !busy ? true : undefined}
    >
      {busy && <span className="pp-auth__spinner" aria-hidden="true" />}
      {busy ? busyLabel : label}
    </Button>
  );
}

// Owner dashboard_Button, Large: Primary (filled) or Outlined, for actions that are not a form submit.
export function ActionButton({
  variant = 'primary',
  busy = false,
  blocked = false,
  busyLabel,
  onClick,
  describedBy,
  children,
}: {
  variant?: 'primary' | 'outlined';
  busy?: boolean;
  blocked?: boolean;
  busyLabel?: string;
  onClick: () => void;
  describedBy?: string;
  children: string;
}) {
  return (
    <Button
      variant={variant === 'primary' ? 'action' : 'outline'}
      className={`pp-auth-btn pp-auth-btn--${variant}`}
      aria-busy={busy ? true : undefined}
      aria-disabled={blocked && !busy ? true : undefined}
      aria-describedby={describedBy}
      onClick={onClick}
    >
      {busy && <span className="pp-auth__spinner" aria-hidden="true" />}
      {busy && busyLabel ? busyLabel : children}
    </Button>
  );
}

// "← Back to sign in" (Text link Tone=Neutral with the Arrow left icon).
export function BackLink({
  onClick,
  disabled,
  children = 'Back to sign in',
}: {
  onClick: () => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <p className="pp-auth__back">
      <button type="button" className="pp-auth-link" disabled={disabled} onClick={onClick}>
        <img src={arrowLeft} alt="" width="20" height="20" />
        {children}
      </button>
    </p>
  );
}

// "Divider or": two lines with "or" between them.
export function OrDivider() {
  return (
    <p className="pp-auth-divider">
      <span>or</span>
    </p>
  );
}

// The Figma "Envelope illustration": Envelope line art with the orange "1" badge. Decorative.
export function MailIllustration() {
  return (
    <span className="pp-auth-mail" aria-hidden="true">
      <img className="pp-auth-mail__art" src={envelopeLineArt} alt="" width="320" height="150" />
      <img className="pp-auth-mail__badge" src={badge} alt="" width="50" height="50" />
      <span className="pp-auth-mail__count">1</span>
    </span>
  );
}

// A centred result screen without the form: illustration, then the heading and its text, then the
// actions ("Check your email", and in recovery "Password updated" / "This reset link can't be used").
// Focus moves to its heading when it opens (S03/S04 handoff, accessibility).
export function StatusPanel({
  art,
  title,
  heading,
  children,
  actions,
}: {
  art: ReactNode;
  title: string;
  heading: Ref<HTMLHeadingElement>;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="pp-auth-status">
      <div className="pp-auth-status__top">
        {art}
        <div className="pp-auth-status__text">
          <h1 className="pp-auth__title" ref={heading} tabIndex={-1}>
            {title}
          </h1>
          <p className="pp-auth__lead">{children}</p>
        </div>
      </div>
      {actions}
    </div>
  );
}

// Resend email (Outlined) with its status line below (S03 handoff, section 6), as one group.
export function ResendGroup({
  busy,
  blocked,
  status,
  onResend,
}: {
  busy: boolean;
  blocked: boolean;
  status: string;
  onResend: () => void;
}) {
  const statusId = useId();
  return (
    <div className="pp-auth-resend">
      <ActionButton
        variant="outlined"
        busy={busy}
        blocked={blocked}
        busyLabel="Sending…"
        describedBy={statusId}
        onClick={onResend}
      >
        Resend email
      </ActionButton>
      <p className="pp-auth-resend__status" id={statusId} aria-live="polite">
        {status}
      </p>
    </div>
  );
}
