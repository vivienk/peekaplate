import type { ButtonHTMLAttributes } from 'react';

type ButtonVariant = 'action' | 'outline' | 'text';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const variantClass: Record<ButtonVariant, string> = {
  action: 'pp-button pp-button--action',
  outline: 'pp-button pp-button--outline',
  text: 'pp-button pp-button--text',
};

export function Button({ variant = 'action', className, ...rest }: ButtonProps) {
  const classes = [variantClass[variant], className].filter(Boolean).join(' ');
  return <button type="button" className={classes} {...rest} />;
}
