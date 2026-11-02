import type { ElementType, HTMLAttributes } from 'react';

type TextVariant =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'paragraph'
  | 'paragraph-2'
  | 'small'
  | 'footer'
  | 'button-label';

const tagFor: Record<TextVariant, ElementType> = {
  h1: 'h1',
  h2: 'h2',
  h3: 'h3',
  h4: 'h4',
  h5: 'h5',
  paragraph: 'p',
  'paragraph-2': 'p',
  small: 'small',
  footer: 'footer',
  'button-label': 'span',
};

export interface TextProps extends HTMLAttributes<HTMLElement> {
  variant?: TextVariant;
  as?: ElementType;
}

export function Text({ variant = 'paragraph', as, className, children, ...rest }: TextProps) {
  const Tag = as ?? tagFor[variant];
  const classes = [`pp-text--${variant}`, className].filter(Boolean).join(' ');
  return (
    <Tag className={classes} {...rest}>
      {children}
    </Tag>
  );
}
