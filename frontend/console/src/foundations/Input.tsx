import { type ComponentPropsWithRef, useId } from 'react';
import './input.css';

type InputProps = Omit<
  ComponentPropsWithRef<'input'>,
  'aria-describedby' | 'aria-invalid' | 'aria-errormessage'
> & {
  label: string;
  hint?: string;
  error?: string;
};

/**
 * Text input foundation (S3-TOK-01). Owns the label, hint and error wiring so every field is
 * named and described the same way. Visual roles wait for the approved Input design.
 */
export function Input({
  label,
  hint: rawHint,
  error: rawError,
  id,
  className,
  ...props
}: InputProps) {
  // Whitespace-only text would announce an empty hint or a false error, so treat it as absent.
  const hint = rawHint?.trim();
  const error = rawError?.trim();
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="pp-input" data-invalid={error ? '' : undefined}>
      <label className="pp-input__label" htmlFor={inputId}>
        {label}
      </label>
      {hint && (
        <p className="pp-input__hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="pp-input__error" id={errorId}>
          <span className="pp-visually-hidden">Error: </span>
          {error}
        </p>
      )}
      <input
        {...props}
        id={inputId}
        className={['pp-input__control', className].filter(Boolean).join(' ')}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
      />
    </div>
  );
}
