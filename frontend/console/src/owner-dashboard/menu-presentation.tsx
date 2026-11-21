import type { ReactNode } from 'react';
import './menu-presentation.css';

// The merged Screen 9 and menu table frame; callers supply data and authorized actions.
export function DishFormFrame({
  title,
  children,
  aside,
}: {
  title: string;
  children: ReactNode;
  aside: ReactNode;
}) {
  return (
    <div className="s09-grid">
      <section className="card s09-card" aria-labelledby="s09-title">
        <h1 id="s09-title">{title}</h1>
        {children}
      </section>
      <div className="s09-side">{aside}</div>
    </div>
  );
}

export function MenuTable({ children }: { children: ReactNode }) {
  return (
    <section className="card mtable" aria-label="Saved dishes">
      <div className="mrow mhead" aria-hidden="true">
        <span />
        <span>Dish</span>
        <span className="hidem">Category</span>
        <span className="hidem">Price</span>
        <span>Status</span>
        <span className="hidem">2.5D preview</span>
        <span />
      </div>
      {children}
    </section>
  );
}
