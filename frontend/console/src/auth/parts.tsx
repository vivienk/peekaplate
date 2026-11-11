// S4-FE-04.1: the pieces the three sign-in screens share. Fields keep the TextField structure
// (label above, one hint or error below, linked with aria-describedby) and the design-system Input.
import { type ReactNode, type Ref, useId, useState } from 'react';
import { Button, Input } from '../ui';
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

const EYE = (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
    <path
      fill="currentColor"
      d="M12 5C7 5 2.73 8.11 1 12c1.73 3.89 6 7 11 7s9.27-3.11 11-7c-1.73-3.89-6-7-11-7Zm0 11.5A4.5 4.5 0 1 1 12 7.5a4.5 4.5 0 0 1 0 9Zm0-7a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z"
    />
  </svg>
);

const EYE_OFF = (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
    <path
      fill="currentColor"
      d="M3.3 2.3 2 3.6l3.1 3.1C3.3 8 1.9 9.9 1 12c1.73 3.89 6 7 11 7 1.9 0 3.6-.4 5.2-1.1l3.2 3.2 1.3-1.3L3.3 2.3ZM12 16.5A4.5 4.5 0 0 1 7.5 12c0-.7.2-1.4.5-2l1.5 1.5a2.5 2.5 0 0 0 3 3l1.5 1.5c-.6.3-1.3.5-2 .5Zm0-11.5c5 0 9.27 3.11 11 7-.7 1.6-1.8 3-3.1 4.1l-2.9-2.9c.3-.6.5-1.4.5-2.2A4.5 4.5 0 0 0 12 7.5c-.8 0-1.6.2-2.2.5L7.6 5.8C9 5.3 10.5 5 12 5Z"
    />
  </svg>
);

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
          {visible ? EYE_OFF : EYE}
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
export function ErrorBanner({ copy, action }: { copy: BannerCopy; action?: ReactNode }) {
  return (
    <div className="pp-auth-banner" role="alert">
      <svg
        className="pp-auth-banner__icon"
        viewBox="0 0 20 20"
        width="20"
        height="20"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="10" cy="10" r="8.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10 5.5v5.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        <circle cx="10" cy="14" r="1.1" fill="currentColor" />
      </svg>
      <div className="pp-auth-banner__text">
        <p className="pp-auth-banner__title">{copy.title}</p>
        <p className="pp-auth-banner__body">{copy.body}</p>
        {action}
      </div>
    </div>
  );
}

// The full-width primary button. While a request runs it shows a spinner and a "…ing" label and
// ignores presses; it is not disabled, so keyboard focus stays on it (S02 handoff, section 4). While
// the service asks the owner to wait (rate limited) it is marked unavailable the same way.
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
      className="pp-auth__submit"
      aria-busy={busy ? true : undefined}
      aria-disabled={blocked && !busy ? true : undefined}
    >
      {busy && <span className="pp-auth__spinner" aria-hidden="true" />}
      {busy ? busyLabel : label}
    </Button>
  );
}

// "← Back to sign in" (Text link Tone=Neutral with back arrow, S03/S04 handoff).
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
        <span aria-hidden="true">← </span>
        {children}
      </button>
    </p>
  );
}

// The envelope from the S03 "Check your email" frame. Decorative.
export const MAIL_ILLUSTRATION = (
  <svg
    className="pp-auth-status__art"
    viewBox="0 0 240 112"
    width="240"
    height="112"
    aria-hidden="true"
    focusable="false"
  >
    <path
      d="M10 112c0-16 14-26 30-24 4-14 20-20 32-12 8-14 32-14 40 2h40c8-16 32-16 40-2 12-8 28-2 32 12 16-2 30 8 30 24Z"
      fill="var(--pp-color-orange-100)"
    />
    <g stroke="var(--pp-color-gray-900)" strokeWidth="3" strokeLinejoin="round" fill="none">
      <rect x="78" y="38" width="84" height="66" rx="5" fill="var(--pp-color-gray-50)" />
      <path d="M80 41 120 76 160 41" />
      <path d="M80 102 108 70M160 102 132 70" />
    </g>
    <g stroke="var(--pp-color-orange-500)" strokeWidth="3" strokeLinecap="round">
      <path d="M120 4v10M98 12l5 8M142 12l-5 8" />
    </g>
    <circle cx="162" cy="40" r="17" fill="var(--pp-color-orange-500)" />
    <text
      x="162"
      y="47"
      textAnchor="middle"
      fontFamily="Inter, system-ui, sans-serif"
      fontSize="20"
      fontWeight="600"
      fill="var(--pp-color-gray-50)"
    >
      1
    </text>
  </svg>
);

// A centred result screen without the form: "Check your email", "Password updated", "This reset
// link can't be used". Focus moves to its heading when it opens (S03/S04 handoff, accessibility).
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
      {art}
      <h1 className="pp-auth__title pp-auth-status__title" ref={heading} tabIndex={-1}>
        {title}
      </h1>
      <p className="pp-auth__lead pp-auth-status__body">{children}</p>
      <div className="pp-auth-status__actions">{actions}</div>
    </div>
  );
}
