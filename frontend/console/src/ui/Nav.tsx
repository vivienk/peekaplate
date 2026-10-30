import type { HTMLAttributes } from 'react';

export interface NavProps extends HTMLAttributes<HTMLElement> {}

export function Nav({ className, ...props }: NavProps) {
  const classes = ['pp-nav', className].filter(Boolean).join(' ');
  return <nav className={classes} {...props} />;
}

export function NavIcon({
  disabled,
  hover,
  className,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { disabled?: boolean; hover?: boolean }) {
  const classes = [
    'pp-nav__icon',
    hover ? 'pp-nav__icon--hover' : '',
    disabled ? 'pp-nav__icon--disabled' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={classes} aria-disabled={disabled || undefined} aria-hidden="true" {...rest} />
  );
}
