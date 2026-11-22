// Owner dashboard_Button, Outlined Medium, that opens the file picker (S05 Upload photo, S07 Replace).
// The Design System Button is the control; the file input stays hidden and out of the tab order.
import { type ChangeEvent, useRef } from 'react';
import { ActionButton } from '../auth/parts';

export function FileButton({
  label,
  accessibleLabel,
  accept,
  multiple = false,
  disabled = false,
  describedBy,
  onChoose,
}: {
  label: string;
  // A fuller name for screen readers, e.g. "Replace menu-1.png".
  accessibleLabel?: string | undefined;
  accept: string;
  multiple?: boolean;
  disabled?: boolean;
  describedBy?: string | undefined;
  onChoose: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);

  function change(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length > 0) onChoose(files);
  }

  return (
    <>
      <input
        ref={input}
        className="pp-onboard-hidden-input"
        type="file"
        accept={accept}
        multiple={multiple}
        tabIndex={-1}
        aria-hidden="true"
        disabled={disabled}
        onChange={change}
      />
      <ActionButton
        variant="outlined"
        size="medium"
        blocked={disabled}
        describedBy={describedBy}
        ariaLabel={accessibleLabel}
        onClick={() => {
          if (!disabled) input.current?.click();
        }}
      >
        {label}
      </ActionButton>
    </>
  );
}
