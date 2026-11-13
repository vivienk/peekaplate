// Icons and logo exported from Rania's Figma (Owner Dashboard, node 2346:6206). Decorative only:
// every use sits next to visible text, so they carry empty alt text.
import action from './assets/action.svg';
import activity from './assets/activity.svg';
import chart from './assets/chart.svg';
import check from './assets/check.svg';
import circle from './assets/circle.svg';
import clock from './assets/clock.svg';
import edit from './assets/edit.svg';
import lock from './assets/fi-rr-lock.svg'; // Figma PeekaPlate Icons / Lock-dot, layer fi-rr-lock (2319:10949)
import home from './assets/home.svg';
import logo from './assets/logo.png';
import menu from './assets/menu.svg';
import report from './assets/report.svg';
import send from './assets/send.svg';
import spark from './assets/spark.svg';
import store from './assets/store.svg';

export const ICONS = {
  action,
  activity,
  chart,
  check,
  circle,
  clock,
  edit,
  home,
  lock,
  logo,
  menu,
  report,
  send,
  spark,
  store,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size,
  className,
}: {
  name: IconName;
  size: number;
  className?: string | undefined;
}) {
  return (
    <img
      src={ICONS[name]}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className={className}
    />
  );
}
