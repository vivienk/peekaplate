// Overview date filter, laid out like an analytics range picker: a button showing the chosen preset
// and dates, then a panel with presets on the left, Start/End date fields on the right, and Cancel
// and Apply. Nothing changes until Apply; Cancel, Escape and clicking outside keep the old range.
// Built from existing parts: the dashboard Btn, the design-system TextField and the chevron icon.
import { useEffect, useId, useRef, useState } from 'react';
import { TextField } from '../foundations/TextField';
import chevron from './assets/icons/angle-small-down.svg';
import { Btn } from './controls';
import {
  customRange,
  DATE_PRESETS,
  type DatePreset,
  type DateRange,
  formatRange,
  presetLabel,
  presetRange,
} from './date-range';

export function DateRangeFilter({
  value,
  onApply,
  now = new Date(),
}: {
  value: DateRange;
  onApply: (range: DateRange) => void;
  /** Injected in tests; defaults to the current time. */
  now?: Date;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<DateRange['preset']>(value.preset);
  const [start, setStart] = useState(value.start);
  const [end, setEnd] = useState(value.end);
  const boxRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const today = now.toISOString().slice(0, 10);
  const draft = customRange(start, end, now);
  const error = draft
    ? undefined
    : !start || !end
      ? 'Enter a start and end date.'
      : end > today
        ? 'The end date cannot be in the future.'
        : 'The start date must be on or before the end date.';

  const reset = () => {
    setPreset(value.preset);
    setStart(value.start);
    setEnd(value.end);
  };
  const close = (refocus = true) => {
    setOpen(false);
    reset();
    if (refocus) triggerRef.current?.focus();
  };
  const pick = (id: DatePreset) => {
    const range = presetRange(id, now);
    setPreset(id);
    setStart(range.start);
    setEnd(range.end);
  };
  const apply = () => {
    if (!draft) return;
    onApply(preset === 'custom' ? draft : { ...draft, preset });
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  });

  return (
    // Escape closes from anywhere in the filter, including the button that opened it.
    // biome-ignore lint/a11y/noStaticElementInteractions: keyboard handling for the children
    <div
      className="drf"
      ref={boxRef}
      onKeyDown={(event) => {
        if (open && event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="drf__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={`${uid}-panel`}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="drf__preset">{presetLabel(value.preset)}</span>
        <span className="drf__dates">{formatRange(value)}</span>
        <img src={chevron} alt="" width={16} height={16} />
      </button>
      {open && (
        <div
          className="drf__panel"
          id={`${uid}-panel`}
          role="dialog"
          aria-label="Choose a date range"
        >
          <fieldset className="drf__presets">
            <legend className="drf__sr">Date range</legend>
            {[...DATE_PRESETS, { id: 'custom', label: 'Custom' } as const].map((option) => (
              <label key={option.id} className="drf__option">
                <input
                  type="radio"
                  name={`${uid}-preset`}
                  value={option.id}
                  checked={preset === option.id}
                  onChange={() => (option.id === 'custom' ? setPreset('custom') : pick(option.id))}
                />
                {option.label}
              </label>
            ))}
          </fieldset>
          <div className="drf__custom">
            <div className="drf__dates-row">
              <TextField
                type="date"
                label="Start date"
                value={start}
                max={end || today}
                onChange={(event) => {
                  setPreset('custom');
                  setStart(event.target.value);
                }}
              />
              <TextField
                type="date"
                label="End date"
                value={end}
                min={start || undefined}
                max={today}
                onChange={(event) => {
                  setPreset('custom');
                  setEnd(event.target.value);
                }}
              />
            </div>
            <p className="drf__note" role={error ? 'alert' : undefined}>
              {error ?? 'Dates are in UTC. Each day runs from midnight to midnight.'}
            </p>
            <div className="drf__foot">
              <Btn kind="text" size="md" type="button" onClick={() => close()}>
                Cancel
              </Btn>
              <Btn kind="primary" size="md" type="button" disabled={!draft} onClick={apply}>
                Apply
              </Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
