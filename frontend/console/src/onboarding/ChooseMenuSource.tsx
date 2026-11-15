// FE-06 S06 Choose how to add your menu (Figma: S06_Choose how to add your menu_Default and
// _Selected; Amr's S06 handoff). Three options, one selection at a time, none selected at first;
// Continue becomes available once one is chosen. A presentational screen: the caller opens S07 (link
// or upload) or S09 (Add dish) from onContinue, and S05 or S12 from onBack.
import { type FormEvent, useId, useState } from 'react';
import { ActionButton, SubmitButton } from '../auth/parts';
import linkIcon from './assets/link.svg';
import pencilIcon from './assets/pencil.svg';
import radioOff from './assets/radio-off.svg';
import radioOn from './assets/radio-on.svg';
import uploadIcon from './assets/upload.svg';

export type MenuSource = 'url' | 'upload' | 'manual';
export type MenuInput = 'url' | 'photo' | 'pdf' | 'manual';

export function ChooseMenuSources({
  onContinue,
  onBack,
}: {
  onContinue: (sources: MenuInput[]) => void;
  onBack: () => void;
}) {
  const [chosen, setChosen] = useState<MenuInput[]>([]);
  const options: { value: MenuInput; label: string; icon: string }[] = [
    { value: 'url', label: 'Paste URL', icon: linkIcon },
    { value: 'photo', label: 'Upload menu photos', icon: uploadIcon },
    { value: 'pdf', label: 'Upload PDF', icon: uploadIcon },
    { value: 'manual', label: 'Add manually', icon: pencilIcon },
  ];
  return (
    <form
      className="pp-onboard-choose"
      onSubmit={(event) => {
        event.preventDefault();
        if (chosen.length) onContinue(chosen);
      }}
    >
      <h1>Choose how to add your menu</h1>
      <p>
        Choose any combination. All saved sources and dishes remain in this restaurant workspace.
      </p>
      <div className="pp-onboard-choose__options" role="group" aria-label="Menu sources">
        {options.map((option) => (
          <label
            key={option.value}
            className={`pp-onboard-option${chosen.includes(option.value) ? ' pp-onboard-option--selected' : ''}`}
          >
            <input
              type="checkbox"
              checked={chosen.includes(option.value)}
              onChange={(event) =>
                setChosen((current) =>
                  event.target.checked
                    ? [...current, option.value]
                    : current.filter((value) => value !== option.value),
                )
              }
            />
            <img src={option.icon} alt="" width={24} height={24} />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      <div className="pp-onboard__actions">
        <ActionButton variant="outlined" onClick={onBack}>
          Back
        </ActionButton>
        <SubmitButton busy={false} blocked={!chosen.length} label="Continue" busyLabel="Continue" />
      </div>
    </form>
  );
}

const OPTIONS: { value: MenuSource; label: string; icon: string }[] = [
  { value: 'url', label: 'Paste URL', icon: linkIcon },
  { value: 'upload', label: 'Upload photos/PDF', icon: uploadIcon },
  { value: 'manual', label: 'Add manually', icon: pencilIcon },
];

export type ChooseMenuSourceProps = {
  // The option to show as chosen when the owner comes back to this screen.
  initial?: MenuSource | undefined;
  onContinue: (source: MenuSource) => void;
  onBack: () => void;
};

export function ChooseMenuSource({ initial, onContinue, onBack }: ChooseMenuSourceProps) {
  const [chosen, setChosen] = useState<MenuSource | undefined>(initial);
  const name = useId();
  const titleId = useId();

  function submit(event: FormEvent) {
    event.preventDefault();
    if (chosen) onContinue(chosen);
  }

  return (
    <form className="pp-onboard-choose" noValidate onSubmit={submit}>
      <div className="pp-onboard-choose__content">
        <h1 className="pp-onboard__title" id={titleId}>
          Choose how to add your menu
        </h1>
        <div className="pp-onboard-choose__options" role="radiogroup" aria-labelledby={titleId}>
          {OPTIONS.map((option) => {
            const selected = chosen === option.value;
            return (
              <label
                key={option.value}
                className={`pp-onboard-option${selected ? ' pp-onboard-option--selected' : ''}`}
              >
                <input
                  className="pp-onboard-option__input"
                  type="radio"
                  name={name}
                  value={option.value}
                  checked={selected}
                  onChange={() => setChosen(option.value)}
                />
                <span className="pp-onboard-option__top" aria-hidden="true">
                  <span className="pp-onboard-option__icon">
                    <img src={option.icon} alt="" width="24" height="24" />
                  </span>
                  <img src={selected ? radioOn : radioOff} alt="" width="24" height="24" />
                </span>
                <span className="pp-onboard-option__label">{option.label}</span>
              </label>
            );
          })}
        </div>
      </div>
      <div className="pp-onboard__actions">
        <ActionButton variant="outlined" onClick={onBack}>
          Back
        </ActionButton>
        <SubmitButton busy={false} blocked={!chosen} label="Continue" busyLabel="Continue" />
      </div>
    </form>
  );
}
