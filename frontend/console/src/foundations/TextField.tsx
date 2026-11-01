import { type ComponentPropsWithRef, useId } from 'react';
import { Input } from '../ui';
import './field.css';

type TextFieldProps = Omit<
  ComponentPropsWithRef<'input'>,
  'aria-describedby' | 'aria-invalid' | 'aria-errormessage'
> & {
  label: string;
  hint?: string;
  error?: string;
};

/**
 * Text field foundation (S3-TOK-01). Wraps the design-system Input (ui/Input, styled by
 * @peekaplate/ui) with a visible label and optional hint and error text, wired so every field is
 * named and described the same way. The box's look comes from the design system; this component
 * owns only the field's structure and accessibility.
 */
export function TextField({
  label,
  hint: rawHint,
  error: rawError,
  id,
  className,
  ref,
  ...props
}: TextFieldProps) {
  // Whitespace-only text would announce an empty hint or a false error, so treat it as absent.
  const hint = rawHint?.trim();
  const error = rawError?.trim();
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="pp-field">
      <label className="pp-field__label" htmlFor={inputId}>
        {label}
      </label>
      {hint && (
        <p className="pp-field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="pp-field__error" id={errorId}>
          <span className="pp-visually-hidden">Error: </span>
          {error}
        </p>
      )}
      <Input
        {...props}
        {...(ref === undefined ? {} : { ref })}
        id={inputId}
        className={['pp-field__control', className].filter(Boolean).join(' ')}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
      />
    </div>
  );
}
