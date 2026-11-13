// FE-05 S05 Restaurant details (Figma: S05_Empty, S05_Validation error, S05_Filled, Dashboard —
// Saved details, Dashboard — Unsaved changes; Amr's S05 handoff). A presentational screen: values
// and save status come in as props, and the owner's actions go out as callbacks, so the API can be
// connected without changing the UI (Ehab, FE-06.2).
import {
  type ChangeEvent,
  type FormEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ActionButton, ErrorBanner, SubmitButton } from '../auth/parts';
import { Input } from '../ui';
import contactIcon from './assets/contact.svg';
import locationIcon from './assets/location.svg';
import photoPlaceholder from './assets/photo-placeholder.png';
import restaurantIcon from './assets/restaurant.svg';
import {
  type RestaurantDetails as Details,
  type DetailsField,
  detailsChanged,
  detailsErrors,
  EMPTY_DETAILS,
  fieldError,
  PHOTO_TYPES,
  photoError,
  trimDetails,
} from './details';
import '../foundations/field.css';

export type RestaurantDetailsProps = {
  // onboarding: first time, from sign-up (S05). dashboard: editing saved details from S12.
  mode: 'onboarding' | 'dashboard';
  // The saved details, when there are any (dashboard).
  saved?: Details | undefined;
  // The saved photo's address, when there is one.
  savedPhotoUrl?: string | null | undefined;
  // Save status from the caller: a request is running, or the last one failed.
  saving?: boolean;
  saveFailed?: boolean;
  // Valid details and the new photo, if the owner chose one. The caller saves them and then opens
  // S06 (onboarding) or S12 (dashboard).
  onSave: (details: Details, photo: File | null) => void;
  // "Go to dashboard" (onboarding) or "Back to dashboard" (dashboard): both open S12.
  onLeave: () => void;
};

const ERROR_SUMMARY = { title: 'Please correct the highlighted errors before saving.', body: '' };
// Save failure is TBD in the handoff; same pattern as the recovery screens.
const SAVE_FAILED = {
  title: 'We couldn’t save your restaurant details',
  body: 'Please try again.',
};

export function RestaurantDetails({
  mode,
  saved,
  savedPhotoUrl,
  saving = false,
  saveFailed = false,
  onSave,
  onLeave,
}: RestaurantDetailsProps) {
  const original = saved ?? EMPTY_DETAILS;
  const [values, setValues] = useState<Details>(original);
  const [touched, setTouched] = useState<Partial<Record<DetailsField, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoProblem, setPhotoProblem] = useState<string>();
  const inputs = useRef<Partial<Record<DetailsField, HTMLInputElement | null>>>({});
  const summary = useRef<HTMLDivElement>(null);

  const errors = useMemo(() => detailsErrors(values), [values]);
  const valid = Object.keys(errors).length === 0;
  const changed = detailsChanged(values, original) || photo !== null;
  // Save is available once the form is valid; from the dashboard it also needs a change (S05
  // handoff, sections 3–5).
  const ready = valid && (mode === 'onboarding' || changed);

  const photoUrl = usePreviewUrl(photo) ?? savedPhotoUrl ?? null;

  const shown = (field: DetailsField) => (touched[field] || submitted ? errors[field] : undefined);

  function update(field: DetailsField, value: string) {
    if (saving) return;
    setValues((current) => ({ ...current, [field]: value }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (!valid) {
      // Save shows as unavailable, but pressing it explains why: every error appears and focus
      // moves to the first one.
      setSubmitted(true);
      const first = (Object.keys(values) as DetailsField[]).find((field) => errors[field]);
      if (first) inputs.current[first]?.focus();
      return;
    }
    if (!ready) return;
    onSave(trimDetails(values), photo);
  }

  function choosePhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || saving) return;
    const problem = photoError(file);
    setPhotoProblem(problem);
    if (!problem) setPhoto(file);
  }

  const field = (name: DetailsField, label: string, placeholder: string, extra = {}) => (
    <DetailsInput
      name={name}
      label={label}
      placeholder={placeholder}
      required={(['name', 'city', 'street', 'phone'] as DetailsField[]).includes(name)}
      value={values[name]}
      error={shown(name)}
      readOnly={saving}
      inputRef={(element) => {
        inputs.current[name] = element;
      }}
      onChange={(value) => update(name, value)}
      onBlur={() => setTouched((current) => ({ ...current, [name]: true }))}
      {...extra}
    />
  );

  return (
    <form className="pp-onboard-details" noValidate onSubmit={submit}>
      <div className="pp-onboard-details__content">
        <h1 className="pp-onboard__title">Restaurant Details</h1>
        <div className="pp-onboard-details__body">
          <PhotoPicker
            url={photoUrl}
            problem={photoProblem}
            disabled={saving}
            onChoose={choosePhoto}
          />
          {saveFailed && !saving && <ErrorBanner copy={SAVE_FAILED} />}
          {submitted && !valid && (
            <div ref={summary}>
              <ErrorBanner copy={ERROR_SUMMARY} />
            </div>
          )}
          <div className="pp-onboard-details__sections">
            <Section icon={restaurantIcon} title="Restaurant information">
              {field('name', 'Restaurant name', 'e.g. Ember & Stone', {
                autoComplete: 'organization',
              })}
            </Section>
            <Section icon={locationIcon} title="Location">
              {field('city', 'City', 'e.g. San Francisco', { autoComplete: 'address-level2' })}
              {field('street', 'Street address', 'e.g. 742 Evergreen Terrace', {
                autoComplete: 'address-line1',
              })}
              {field(
                'line2',
                'Address line 2 (Optional)',
                'Suite, unit, floor, building (optional)',
                {
                  autoComplete: 'address-line2',
                },
              )}
            </Section>
            <Section icon={contactIcon} title="Contact details">
              <div className="pp-onboard-details__pair">
                {field('phone', 'Phone number', 'e.g. (555) 234-5678', {
                  type: 'tel',
                  inputMode: 'tel',
                  autoComplete: 'tel',
                })}
                {field('email', 'Contact email', 'e.g. owner@emberandstone.com', {
                  type: 'email',
                  inputMode: 'email',
                  autoComplete: 'email',
                })}
              </div>
            </Section>
          </div>
        </div>
      </div>
      <div className="pp-onboard__actions">
        <ActionButton variant="outlined" onClick={onLeave}>
          {mode === 'onboarding' ? 'Go to dashboard' : 'Back to dashboard'}
        </ActionButton>
        <SubmitButton busy={saving} blocked={!ready} label="Save" busyLabel="Saving…" />
      </div>
    </form>
  );
}

// A section header: the 48px orange icon tile and the 18/28 title, then its fields.
function Section({
  icon,
  title,
  children,
}: {
  icon: string;
  title: string;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <section className="pp-onboard-section" aria-labelledby={id}>
      <div className="pp-onboard-section__head">
        <span className="pp-onboard-section__icon" aria-hidden="true">
          <img src={icon} alt="" width="24" height="24" />
        </span>
        <h2 className="pp-onboard-section__title" id={id}>
          {title}
        </h2>
      </div>
      <div className="pp-onboard-section__fields">{children}</div>
    </section>
  );
}

// Input Field Default: label with a red star when required, the Figma input, and its error below.
function DetailsInput({
  name,
  label,
  placeholder,
  required,
  value,
  error,
  readOnly,
  inputRef,
  onChange,
  onBlur,
  ...rest
}: {
  name: string;
  label: string;
  placeholder: string;
  required: boolean;
  value: string;
  error: string | undefined;
  readOnly: boolean;
  inputRef: (element: HTMLInputElement | null) => void;
  onChange: (value: string) => void;
  onBlur: () => void;
  type?: string;
  inputMode?: 'tel' | 'email';
  autoComplete?: string;
}) {
  const id = useId();
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="pp-field">
      <label className="pp-field__label" htmlFor={id}>
        {label}
        {required && (
          <span className="pp-onboard-required" aria-hidden="true">
            *
          </span>
        )}
      </label>
      <Input
        {...rest}
        ref={inputRef}
        id={id}
        name={name}
        className="pp-field__control"
        placeholder={placeholder}
        value={value}
        required={required}
        readOnly={readOnly}
        aria-describedby={errorId}
        aria-invalid={error ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />
      {error && (
        <p className="pp-field__error" id={errorId}>
          <span className="pp-visually-hidden">Error: </span>
          {error}
        </p>
      )}
    </div>
  );
}

// Upload photo: the 250px photo (or the placeholder) with an Outlined Medium button over it.
function PhotoPicker({
  url,
  problem,
  disabled,
  onChoose,
}: {
  url: string | null;
  problem: string | undefined;
  disabled: boolean;
  onChoose: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const id = useId();
  const problemId = problem ? `${id}-problem` : undefined;
  return (
    <div className="pp-onboard-photo">
      <div className="pp-onboard-photo__frame">
        <img
          className="pp-onboard-photo__image"
          src={url ?? photoPlaceholder}
          alt={url ? 'Restaurant photo' : ''}
          width="250"
          height="250"
        />
        <input
          id={id}
          className="pp-onboard-photo__input"
          type="file"
          accept={PHOTO_TYPES.join(',')}
          disabled={disabled}
          aria-describedby={problemId}
          onChange={onChoose}
        />
        <label htmlFor={id} className="pp-onboard-photo__button">
          {url ? 'Change photo' : 'Upload photo'}
        </label>
      </div>
      {problem && (
        <p className="pp-field__error pp-onboard-photo__problem" id={problemId} role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

// A temporary address for the chosen photo's preview, released when it changes.
function usePreviewUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}
