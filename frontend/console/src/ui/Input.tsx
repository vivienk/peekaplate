import type { InputHTMLAttributes } from 'react';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const classes = ['pp-input', className].filter(Boolean).join(' ');
  return <input className={classes} {...props} />;
}
