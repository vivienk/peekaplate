import type { InputHTMLAttributes } from 'react';

export function Input({
  className,
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: React.Ref<HTMLInputElement> }) {
  const classes = ['pp-input', className].filter(Boolean).join(' ');
  return <input ref={ref} className={classes} {...props} />;
}
