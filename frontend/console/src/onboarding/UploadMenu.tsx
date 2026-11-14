// FE-06 S07 Upload your menu (Figma: S07_Upload your menu Default, Files Uploading, Preview files,
// Uploading failed, File not supported, File too large; Amr's S07 Files handoff). A presentational
// screen: it checks chosen files in the browser and hands the acceptable ones to the caller, which
// uploads them and reports each file's status back through `files`. Continue opens S08 Processing
// once every file is uploaded; Back returns to S06.
import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type ReactNode,
  useId,
  useState,
} from 'react';
import { ActionButton, ErrorBanner, SubmitButton } from '../auth/parts';
import cloudIcon from './assets/cloud-upload.svg';
import fileErrorIcon from './assets/file-error.svg';
import imageIcon from './assets/image.svg';
import retryIcon from './assets/retry.svg';
import trashIcon from './assets/trash.svg';
import { checkMenuFiles, formatFileSize, MENU_FILE_ACCEPT, type MenuFileKind } from './menu-source';

export type MenuUploadStatus = 'uploading' | 'uploaded' | 'failed';

export type MenuUpload = {
  // The caller's id for this file; it comes back in onReplace, onRemove and onRetry.
  id: string;
  name: string;
  // In bytes.
  size: number;
  kind: MenuFileKind;
  status: MenuUploadStatus;
  // 0–100 while uploading. Leave it out when the upload cannot report progress: the bar then shows
  // that the upload is running without a percentage.
  progress?: number | undefined;
  // An image of the file for Preview files: the photo itself, or the PDF's first page if the
  // server makes one. Without it the preview says none is available.
  previewUrl?: string | null | undefined;
};

export type UploadMenuProps = {
  files: readonly MenuUpload[];
  // Files that passed the checks, in the order chosen. The caller adds them to `files` and uploads.
  onAdd: (files: File[]) => void;
  // A file that passed the checks, to upload in place of the file with this id.
  onReplace: (id: string, file: File) => void;
  onRemove: (id: string) => void;
  // Upload the failed file again.
  onRetry: (id: string) => void;
  // Every file is uploaded; the caller opens S08 Processing.
  onContinue: () => void;
  onBack: () => void;
};

const UPLOAD_FAILED = 'Something went wrong, please try again.';

export function UploadMenu({
  files,
  onAdd,
  onReplace,
  onRemove,
  onRetry,
  onContinue,
  onBack,
}: UploadMenuProps) {
  const [problem, setProblem] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const inputId = useId();
  const hintId = useId();
  const problemId = useId();

  const previewing = files.length > 0 && files.every((file) => file.status === 'uploaded');

  function add(chosen: File[]) {
    if (chosen.length === 0) return;
    const check = checkMenuFiles(
      files.map((file) => file.kind),
      chosen,
    );
    setProblem(check.problem);
    if (check.accepted.length > 0) onAdd(check.accepted);
  }

  function replace(id: string, file: File) {
    const check = checkMenuFiles(
      files.filter((other) => other.id !== id).map((other) => other.kind),
      [file],
    );
    setProblem(check.problem);
    const [accepted] = check.accepted;
    if (accepted) onReplace(id, accepted);
  }

  function remove(id: string) {
    setProblem(undefined);
    onRemove(id);
  }

  function choose(event: ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(event.target.files ?? []);
    event.target.value = '';
    add(chosen);
  }

  function drop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    add(Array.from(event.dataTransfer.files));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (previewing) onContinue();
  }

  return (
    <>
      <form
        className="pp-onboard__card pp-onboard-upload"
        noValidate
        aria-labelledby={`${inputId}-title`}
        onSubmit={submit}
      >
        <div className="pp-onboard-upload__main">
          <div className="pp-onboard-upload__content">
            <h1 className="pp-onboard__title" id={`${inputId}-title`}>
              Upload your menu
            </h1>
            <section
              className={`pp-onboard-drop${dragging ? ' pp-onboard-drop--active' : ''}`}
              aria-label="Add menu files"
              onDragEnter={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setDragging(false);
                }
              }}
              onDrop={drop}
            >
              <img
                className="pp-onboard-drop__icon"
                src={cloudIcon}
                alt=""
                width="150"
                height="150"
              />
              <div className="pp-onboard-drop__text">
                <p className="pp-onboard-drop__line">
                  Drag and drop or{' '}
                  <input
                    id={inputId}
                    className="pp-onboard-hidden-input"
                    type="file"
                    multiple
                    accept={MENU_FILE_ACCEPT.join(',')}
                    aria-describedby={problem ? `${hintId} ${problemId}` : hintId}
                    onChange={choose}
                  />
                  <label htmlFor={inputId} className="pp-auth-link pp-auth-link--accent">
                    Choose file
                  </label>{' '}
                  to upload.
                </p>
                <p className="pp-onboard-drop__hint" id={hintId}>
                  JPEG, PNG or PDF. Up to 5 images or 1 PDF, with up to 10 pages. Maximum 12 MB per
                  file.
                </p>
              </div>
            </section>
            {problem && (
              <div id={problemId} className="pp-onboard-upload__problem">
                <ErrorBanner copy={{ title: problem, body: '' }} />
              </div>
            )}
          </div>
          <div className="pp-onboard__actions">
            <ActionButton variant="outlined" onClick={onBack}>
              Back
            </ActionButton>
            <SubmitButton
              busy={false}
              blocked={!previewing}
              label="Continue"
              busyLabel="Continue"
            />
          </div>
        </div>
        {previewing && (
          <section className="pp-onboard-preview" aria-labelledby={`${inputId}-preview`}>
            <div className="pp-onboard-preview__head">
              <h2 className="pp-onboard-preview__title" id={`${inputId}-preview`}>
                Preview
              </h2>
              <p className="pp-onboard-preview__note">
                Check that your menu is clear and readable before continuing.
              </p>
            </div>
            <ul className="pp-onboard-preview__list">
              {files.map((file) => (
                <li key={file.id} className="pp-onboard-preview__card">
                  <FileName file={file} />
                  <div className="pp-onboard-preview__body">
                    {file.previewUrl ? (
                      <img
                        className="pp-onboard-preview__image"
                        src={file.previewUrl}
                        alt={`Preview of ${file.name}`}
                      />
                    ) : (
                      <p className="pp-onboard-preview__none">No preview available for this file</p>
                    )}
                    <div className="pp-onboard-preview__actions">
                      <ReplaceButton file={file} onChoose={(chosen) => replace(file.id, chosen)} />
                      <button
                        type="button"
                        className="pp-auth-link pp-auth-link--accent"
                        aria-label={`Remove ${file.name}`}
                        onClick={() => remove(file.id)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </form>
      {!previewing && files.length > 0 && (
        <ul className="pp-onboard-uploads" aria-label="Uploads">
          {files.map((file) => (
            <UploadRow
              key={file.id}
              file={file}
              onReplace={(chosen) => replace(file.id, chosen)}
              onRemove={() => remove(file.id)}
              onRetry={() => onRetry(file.id)}
            />
          ))}
        </ul>
      )}
    </>
  );
}

// The image icon, the file name (18/28 semibold) and its size.
function FileName({ file }: { file: MenuUpload }) {
  return (
    <div className="pp-onboard-file">
      <img src={imageIcon} alt="" width="24" height="24" />
      <p className="pp-onboard-file__text">
        <span className="pp-onboard-file__name">{file.name}</span>
        <span className="pp-onboard-file__size">{formatFileSize(file.size)}</span>
      </p>
    </div>
  );
}

// Owner dashboard_Button, Outlined Medium, as the label of a hidden file input.
function ReplaceButton({ file, onChoose }: { file: MenuUpload; onChoose: (file: File) => void }) {
  const id = useId();
  return (
    <>
      <input
        id={id}
        className="pp-onboard-hidden-input"
        type="file"
        accept={MENU_FILE_ACCEPT.join(',')}
        aria-label={`Replace ${file.name}`}
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          event.target.value = '';
          if (chosen) onChoose(chosen);
        }}
      />
      <label htmlFor={id} className="pp-onboard-small-btn" aria-hidden="true">
        Replace
      </label>
    </>
  );
}

// in-progress-upload: name and size with Replace and the bin, the progress bar with its percentage
// (or Retry once it failed), and the error under it.
function UploadRow({
  file,
  onReplace,
  onRemove,
  onRetry,
}: {
  file: MenuUpload;
  onReplace: (file: File) => void;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const errorId = useId();
  const failed = file.status === 'failed';
  const known = file.progress !== undefined;
  const progress = Math.max(0, Math.min(100, Math.round(file.progress ?? 0)));
  const shownProgress = file.status === 'uploaded' ? 100 : progress;
  let end: ReactNode = null;
  if (failed) {
    end = (
      <button
        type="button"
        className="pp-onboard-icon-btn pp-onboard-icon-btn--small"
        aria-label={`Retry ${file.name}`}
        onClick={onRetry}
      >
        <img src={retryIcon} alt="" width="20" height="20" />
      </button>
    );
  } else if (known || file.status === 'uploaded') {
    end = (
      <span className="pp-onboard-upload-row__percent" aria-hidden="true">
        {shownProgress}%
      </span>
    );
  }
  return (
    <li className={`pp-onboard-upload-row${failed ? ' pp-onboard-upload-row--failed' : ''}`}>
      <div className="pp-onboard-upload-row__top">
        <FileName file={file} />
        <div className="pp-onboard-upload-row__buttons">
          <ReplaceButton file={file} onChoose={onReplace} />
          <button
            type="button"
            className="pp-onboard-icon-btn"
            aria-label={`Remove ${file.name}`}
            onClick={onRemove}
          >
            <img src={trashIcon} alt="" width="24" height="24" />
          </button>
        </div>
      </div>
      <div className="pp-onboard-upload-row__progress">
        <div
          className={`pp-onboard-progress${!known && !failed && file.status === 'uploading' ? ' pp-onboard-progress--running' : ''}`}
          role="progressbar"
          aria-label={`Upload of ${file.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={known || file.status === 'uploaded' ? shownProgress : undefined}
          aria-describedby={failed ? errorId : undefined}
        >
          <span
            className="pp-onboard-progress__fill"
            style={known || file.status === 'uploaded' ? { width: `${shownProgress}%` } : undefined}
          />
        </div>
        {end}
      </div>
      {failed && (
        <p className="pp-onboard-upload-row__error" id={errorId} role="alert">
          <img src={fileErrorIcon} alt="" width="24" height="24" />
          {UPLOAD_FAILED}
        </p>
      )}
    </li>
  );
}
