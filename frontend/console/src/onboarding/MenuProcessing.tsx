// FE-06 S08 menu processing (Figma: S08_Processing (Photo/PDF), S08_No dishes found,
// S08_Extraction failed; Amr's S08 handoff, items 1–3). A presentational screen: the caller reports
// the extraction's state and the screen follows it, so the result appears on its own when processing
// ends. Cancel opens S12; Try another source opens S06.
//
// Not here: S08 "Your menu is ready to review" (Figma 1937:6239; handoff item 4). Harshita builds
// it with S10 (FE-10), per Adam. When dishes are found the caller opens that screen instead.
import { useEffect, useId, useRef } from 'react';
import { ActionButton, ErrorBanner } from '../auth/parts';
import bowlIcon from './assets/bowl-sad.svg';
import fileIcon from './assets/file-info.svg';
import imageIcon from './assets/image.svg';
import linkIcon from './assets/link-small.svg';
import menuEmptyIcon from './assets/menu-empty.svg';
import processingIcon from './assets/processing.svg';
import { formatFileSize } from './menu-source';

export type MenuProcessingState = 'processing' | 'no-dishes' | 'failed';

// What the menu came from, listed under "Your source" when extraction fails.
export type MenuSourceItem = {
  name: string;
  kind: 'image' | 'pdf' | 'link';
  // In bytes; not shown for a link.
  size?: number | undefined;
};

export type MenuProcessingProps = {
  state: MenuProcessingState;
  // The current step while processing, if the server reports one (Figma: "Identifying menu
  // sections...").
  step?: string | undefined;
  // Why extraction failed, shown after "Extraction error —" (Figma: "Unable to read file content").
  failureReason?: string | undefined;
  // The files or link the extraction used (Extraction failed).
  sources?: readonly MenuSourceItem[] | undefined;
  // Back to S12 Dashboard.
  onCancel: () => void;
  // Back to S06 Choose how to add your menu.
  onTryAnother: () => void;
};

const KIND_LABEL: Record<MenuSourceItem['kind'], string> = {
  image: 'Image',
  pdf: 'PDF',
  link: 'Web page',
};

function sourceLabel(item: MenuSourceItem): string {
  if (item.kind !== 'image') return KIND_LABEL[item.kind];
  const ending = item.name.toLowerCase().match(/\.(jpe?g|png)$/)?.[1];
  return ending === 'png' ? 'PNG image' : ending ? 'JPEG image' : 'Image';
}

export function MenuProcessing({
  state,
  step = 'Identifying menu sections...',
  failureReason = 'Unable to read file content',
  sources = [],
  onCancel,
  onTryAnother,
}: MenuProcessingProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const first = useRef(true);

  // The result replaces the processing screen on its own; move focus to its heading so screen
  // readers announce it (not on first arrival, which the page navigation already announces).
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [state]);

  return (
    <section className="pp-onboard-process" aria-labelledby={titleId}>
      <div className="pp-onboard-process__content">
        {state === 'processing' && (
          <>
            <span className="pp-onboard-process__tile" aria-hidden="true">
              <img
                className="pp-onboard-process__spinner"
                src={processingIcon}
                alt=""
                width="96"
                height="96"
              />
            </span>
            <div className="pp-onboard-process__body">
              <div className="pp-onboard-process__head">
                <h1 className="pp-onboard__title" id={titleId} ref={heading} tabIndex={-1}>
                  Processing your menu
                </h1>
                <div className="pp-onboard-process__lead">
                  <p className="pp-onboard-process__step" role="status">
                    {step}
                  </p>
                  <p className="pp-onboard-process__text">
                    We’re extracting dishes from your menu. You can review and edit the results when
                    processing is complete.
                  </p>
                </div>
              </div>
              <div className="pp-onboard-info">
                <span className="pp-onboard-info__icon" aria-hidden="true">
                  <img src={fileIcon} alt="" width="20" height="20" />
                </span>
                <div className="pp-onboard-info__text">
                  <h2 className="pp-onboard-info__title">What's happening right now?</h2>
                  <p className="pp-onboard-info__body">
                    We're identifying sections, dish names, prices, and descriptions. This step
                    prepares an unverified draft for your review.
                  </p>
                  <p className="pp-onboard-info__note">
                    No items will go live or be published without your explicit confirmation.
                  </p>
                </div>
              </div>
            </div>
          </>
        )}
        {state === 'no-dishes' && (
          <>
            <span className="pp-onboard-process__tile" aria-hidden="true">
              <img src={menuEmptyIcon} alt="" width="96" height="96" />
            </span>
            <div className="pp-onboard-process__intro">
              <h1 className="pp-onboard__title" id={titleId} ref={heading} tabIndex={-1}>
                No dishes found
              </h1>
              <p className="pp-onboard-process__text">
                We couldn’t find any dishes in this source. Try a different source or add your
                dishes manually.
              </p>
            </div>
          </>
        )}
        {state === 'failed' && (
          <>
            <span
              className="pp-onboard-process__tile pp-onboard-process__tile--error"
              aria-hidden="true"
            >
              <img src={bowlIcon} alt="" width="100" height="80" />
            </span>
            <div className="pp-onboard-process__body">
              <h1 className="pp-onboard__title" id={titleId} ref={heading} tabIndex={-1}>
                We couldn’t process your menu
              </h1>
              <ErrorBanner
                copy={{
                  title: `Extraction error — ${failureReason}`,
                  body: 'We couldn’t process your menu. Try again, use another source, or enter your dishes manually.',
                }}
              />
              {sources.length > 0 && (
                <section className="pp-onboard-sources" aria-labelledby={`${titleId}-sources`}>
                  <h2 className="pp-onboard-sources__title" id={`${titleId}-sources`}>
                    Your source
                  </h2>
                  <ul className="pp-onboard-sources__list">
                    {sources.map((item) => (
                      <li key={`${item.kind}-${item.name}`} className="pp-onboard-sources__item">
                        <img
                          src={item.kind === 'link' ? linkIcon : imageIcon}
                          alt=""
                          width="24"
                          height="24"
                        />
                        <span className="pp-onboard-sources__name">{item.name}</span>
                        <span className="pp-onboard-sources__meta">
                          <span>{sourceLabel(item)}</span>
                          {item.size !== undefined && item.kind !== 'link' && (
                            <span>{formatFileSize(item.size)}</span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </>
        )}
      </div>
      <div className="pp-onboard__actions">
        <ActionButton variant="outlined" onClick={onCancel}>
          Cancel
        </ActionButton>
        {state !== 'processing' && (
          <ActionButton variant="primary" onClick={onTryAnother}>
            Try another source
          </ActionButton>
        )}
      </div>
    </section>
  );
}
