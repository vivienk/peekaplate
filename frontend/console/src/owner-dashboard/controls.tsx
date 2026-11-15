import type { CSSProperties, ReactNode } from 'react';
import { Button, type ButtonProps } from '../ui';
import action from './assets/icons/action.svg';
import back from './assets/icons/back.svg';
import chart from './assets/icons/chart.svg';
import chat from './assets/icons/chat.svg';
import check from './assets/icons/check.svg';
import edit from './assets/icons/edit.svg';
import home from './assets/icons/home.svg';
import info from './assets/icons/info.svg';
import menu from './assets/icons/menu.svg';
import plus from './assets/icons/plus.svg';
import report from './assets/icons/report.svg';
import search from './assets/icons/search.svg';
import send from './assets/icons/send.svg';
import spark from './assets/icons/spark.svg';
import store from './assets/icons/store.svg';
import warn from './assets/icons/warn.svg';
import x from './assets/icons/x.svg';

/* Icons exported from Rania's Figma file (l7A9n8tACJic0FIhY49Zjw), unchanged:
   - "PeekaPlate Icons" set 356:5320: home, report, chart, menu, action, store, check, search,
     x (cross-small), back (Arrow-left), warn (warning), edit (Edit);
   - "Rounded Corners_Regular" set 343:8163 (the icon family the Buttons component uses):
     info (fi-rr-info), plus (fi-rr-plus), chat (fi-rr-comment);
   - "AI panel" component (owner S12, 2346:6265): spark, send. */
const ICONS = {
  action,
  back,
  chart,
  chat,
  check,
  edit,
  home,
  info,
  menu,
  plus,
  report,
  search,
  send,
  spark,
  store,
  warn,
  x,
};
export type IconName = keyof typeof ICONS;

/** Draws the Figma SVG as a mask, so the icon keeps Figma's exact shape and takes the
 *  surrounding text colour (nav states, buttons, notes) instead of a fixed fill. */
export function Icon({ n, s = 20 }: { n: IconName; s?: number }) {
  const style = { width: s, height: s, '--ic': `url("${ICONS[n]}")` } as CSSProperties;
  return <span className="ic" aria-hidden="true" style={style} />;
}

/** Reusable icon container for feature/step cards: a fixed box with no background fill. */
export function IconTile({ n, s = 20 }: { n: IconName; s?: number }) {
  return (
    <span className="icontile">
      <Icon n={n} s={s} />
    </span>
  );
}

/* Owner buttons follow Rania's Figma components, built on the shared @peekaplate/ui Button:
   - kind "primary" / "outlined" = "Owner dashboard_Button" 1563:8484 (Type=Primary/Outlined);
     size "md" = Size=Medium (40px, 16px label), "lg" = Size=Large (48px, 18px label);
   - kind "text" = "Text link" 1449:11145 (Tone=Accent), for low-emphasis actions such as
     Back, Dismiss and Undo. An optional leading icon is the component's "Show Icon" slot. */
export type BtnKind = 'primary' | 'outlined' | 'text';
const VARIANT = { primary: 'action', outlined: 'outline', text: 'text' } as const;

export function Btn({
  kind = 'outlined',
  size = 'lg',
  icon,
  className,
  children,
  ...rest
}: Omit<ButtonProps, 'variant'> & { kind?: BtnKind; size?: 'md' | 'lg'; icon?: IconName }) {
  const classes = ['ob', `ob--${kind}`, `ob--${size}`, className].filter(Boolean).join(' ');
  return (
    <Button variant={VARIANT[kind]} className={classes} {...rest}>
      {icon && <Icon n={icon} s={kind === 'text' ? 16 : 20} />}
      {children}
    </Button>
  );
}

export function Note({
  kind,
  icon = 'info',
  children,
}: {
  kind?: string;
  icon?: IconName;
  children: ReactNode;
}) {
  return (
    <div
      className={`note ${kind || ''}`}
      role={kind === 'warn' || kind === 'coral' ? 'status' : undefined}
    >
      <Icon n={icon} s={18} />
      <div>{children}</div>
    </div>
  );
}
