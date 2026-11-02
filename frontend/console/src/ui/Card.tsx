import type { HTMLAttributes } from 'react';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  elevated?: boolean;
}

export function Card({ elevated, className, ...rest }: CardProps) {
  const classes = ['pp-card', elevated ? 'pp-card--elevated' : '', className]
    .filter(Boolean)
    .join(' ');
  return <div className={classes} {...rest} />;
}
