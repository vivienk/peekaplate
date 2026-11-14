// FE-06 S07 Add your menu link (Figma: S07_Add your menu link Default, Valid URL / Ready to import,
// Loading, Validation Error, Private url, Source failed; Amr's S07 URL handoff). A presentational
// screen: the caller imports the link from onImport and reports how it went through importing and
// failure; when the link is accepted the caller opens S08 Processing. Back returns to S06.
import { type FormEvent, useId, useRef, useState } from 'react';
import { ActionButton, ErrorBanner, SubmitButton } from '../auth/parts';
import { Input } from '../ui';
import brokenLinkIcon from './assets/broken-link.svg';
import checkIcon from './assets/check.svg';
import linkIcon from './assets/link-small.svg';
import { isMenuUrl } from './menu-source';
import '../foundations/field.css';

// Why the server could not import the link: it could not be read (private, needs a login, or did
// not answer), or it is a kind of page the import does not support.
export type MenuLinkFailure = 'private' | 'unsupported';

export type AddMenuLinkProps = {
  // The link to show when the owner comes back to this screen.
  initialUrl?: string | undefined;
  // The import request is running.
  importing?: boolean;
  // The last import failed, and why. It applies to the link that was sent: once the owner edits
  // the link, the message goes and Import menu is available again.
  failure?: MenuLinkFailure | undefined;
  // A link in a valid format, trimmed. The caller imports it and opens S08 Processing.
  onImport: (url: string) => void;
  onBack: () => void;
};

const INVALID = {
  title: 'Invalid Web Address',
  body: 'Please enter a valid web address starting with http:// or https://',
};

const FAILURES: Record<MenuLinkFailure, { title: string; body: string }> = {
  private: {
    title: 'Menu link could not be accessed',
    body: 'We couldn’t access this menu. Check that the link is public and try again.',
  },
  unsupported: {
    title: 'This source cannot be imported automatically',
    body: 'This link is not supported. Use a public menu page from your restaurant website, or upload menu photos or a PDF.',
  },
};

export function AddMenuLink({
  initialUrl = '',
  importing = false,
  failure,
  onImport,
  onBack,
}: AddMenuLinkProps) {
  const [url, setUrl] = useState(initialUrl);
  const [checked, setChecked] = useState(false);
  // The link the last import was for, so a failure only applies while it is unchanged.
  const [sent, setSent] = useState<string | null>(initialUrl.trim() || null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const messageId = useId();

  const value = url.trim();
  const valid = isMenuUrl(value);
  const failed = !importing && failure !== undefined && sent === value;
  const invalidShown = checked && value !== '' && !valid;
  const ready = valid && !failed && !importing;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (importing) return;
    if (!valid) {
      // Import shows as unavailable, but pressing it with a wrong address explains why.
      if (value) setChecked(true);
      input.current?.focus();
      return;
    }
    if (failed) return;
    setSent(value);
    onImport(value);
  }

  const message = invalidShown ? (
    <ErrorBanner copy={INVALID} />
  ) : failed && failure ? (
    <ErrorBanner copy={FAILURES[failure]} icon={brokenLinkIcon} />
  ) : null;

  return (
    <form className="pp-onboard-link" noValidate onSubmit={submit}>
      <div className="pp-onboard-link__content">
        <h1 className="pp-onboard__title">Add your menu link</h1>
        <div className="pp-onboard-link__field">
          <div className="pp-field">
            <label className="pp-field__label" htmlFor={id}>
              Menu URL
            </label>
            <div className="pp-onboard-link__control">
              <img className="pp-onboard-link__icon" src={linkIcon} alt="" width="16" height="16" />
              <Input
                ref={input}
                id={id}
                name="menuUrl"
                type="url"
                inputMode="url"
                autoComplete="url"
                spellCheck={false}
                className="pp-field__control pp-onboard-link__input"
                placeholder="Enter your URL"
                value={url}
                readOnly={importing}
                aria-invalid={invalidShown ? true : undefined}
                aria-describedby={message ? messageId : undefined}
                onChange={(event) => setUrl(event.target.value)}
                onBlur={() => setChecked(true)}
              />
              {valid && (
                <img
                  className="pp-onboard-link__check"
                  src={checkIcon}
                  alt=""
                  width="16"
                  height="16"
                />
              )}
            </div>
          </div>
          {message && <div id={messageId}>{message}</div>}
        </div>
      </div>
      <div className="pp-onboard__actions">
        <ActionButton variant="outlined" onClick={onBack}>
          Back
        </ActionButton>
        <SubmitButton busy={importing} blocked={!ready} label="Import menu" busyLabel="Loading" />
      </div>
    </form>
  );
}
