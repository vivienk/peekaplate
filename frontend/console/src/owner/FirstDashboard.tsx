// S12 first dashboard arrival (Figma "Owner / 12 First-time Dashboard New", node 2346:6206).
// Shown before full dashboard access: setup progress, the next action, the three setup steps,
// verified-vs-published status and an honest empty state. It never shows metrics.
import { Button } from '../ui';
import { Icon, type IconName } from './icons';
import { type OwnerPage, OwnerShell } from './OwnerShell';
import { type OwnerSetup, type StepId, setupProgress, setupSteps, type Tone } from './setup';

function StatusLabel({
  text,
  tone,
  icon,
}: {
  text: string;
  tone: Tone;
  icon?: IconName | undefined;
}) {
  return (
    <span className={`owner-status owner-status--${tone}`}>
      <Icon name={icon ?? (tone === 'success' ? 'check' : 'lock')} size={16} />
      {text}
    </span>
  );
}

export interface FirstDashboardProps {
  setup: OwnerSetup;
  /** Opens an onboarding step (S05 details, S06–S10 menu, review/publish). */
  onOpenStep: (step: StepId) => void;
  onNavigate: (page: OwnerPage) => void;
  /** True only on labelled previews with fictional data. */
  sample?: boolean;
}

export function FirstDashboard({ setup, onOpenStep, onNavigate, sample }: FirstDashboardProps) {
  const steps = setupSteps(setup);
  const progress = setupProgress(setup);
  const percent = Math.round((progress.done / progress.total) * 100);

  const topbar = (
    <>
      <div className="owner-chips">
        {sample && <span className="owner-chip">Illustrative sample data</span>}
        {setup.reportPeriod && <span className="owner-chip">{setup.reportPeriod}</span>}
      </div>
      {setup.published ? (
        <StatusLabel text="Published" tone="success" />
      ) : (
        <StatusLabel text="Not published" tone="warning" />
      )}
    </>
  );

  const aside = (
    <aside className="owner-ai" aria-label="PeekaPlate AI">
      <div className="owner-ai__head">
        <div className="owner-ai__title">
          <span className="owner-ai__icon">
            <Icon name="spark" size={16} />
          </span>
          <h2>PeekaPlate AI</h2>
        </div>
        <div className="owner-chips">
          <span className="owner-chip owner-chip--surface">{setup.restaurantName}</span>
          {setup.reportPeriod && (
            <span className="owner-chip owner-chip--surface">{setup.reportPeriod}</span>
          )}
        </div>
      </div>
      <div className="owner-ai__body">
        <p className="owner-muted">
          Ask about dish activity or your reports. Answers use only the records shown on these
          pages.
        </p>
        <h3>No questions yet</h3>
        <p className="owner-muted" id="owner-ai-empty">
          There are no reports or dish activity to ask about yet. Once your menu is published and
          diners start using PeekaPlate, you can ask questions here.
        </p>
      </div>
      <form className="owner-ai__composer" onSubmit={(event) => event.preventDefault()}>
        <label className="owner-visually-hidden" htmlFor="owner-ai-input">
          Ask about your dishes
        </label>
        <input
          id="owner-ai-input"
          className="owner-ai__input"
          placeholder="Ask about your dishes…"
          disabled
          aria-describedby="owner-ai-empty"
        />
        <button type="submit" className="owner-ai__send" disabled aria-label="Send question">
          <Icon name="send" size={18} />
        </button>
      </form>
    </aside>
  );

  return (
    <OwnerShell
      restaurantName={setup.restaurantName}
      current="setup"
      onNavigate={onNavigate}
      setupIncomplete={progress.next !== null}
      topbar={topbar}
      aside={aside}
    >
      <div className="owner-welcome">
        <h1>Welcome to PeekaPlate</h1>
        <p>
          Finish setting up {setup.restaurantName}. Nothing is shown to diners until you review it
          and choose to publish.
        </p>
      </div>

      <section className="owner-card owner-progress" aria-labelledby="owner-progress-title">
        <div className="owner-progress__head">
          <h2 id="owner-progress-title">Setup progress</h2>
          <p>
            {progress.done} of {progress.total} steps complete
          </p>
        </div>
        <div
          className="owner-progress__track"
          role="progressbar"
          aria-labelledby="owner-progress-title"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
          aria-valuetext={`${progress.done} of ${progress.total} steps complete`}
        >
          <div className="owner-progress__fill" style={{ width: `${percent}%` }} />
        </div>
        {(progress.next || progress.review) && (
          <div className="owner-progress__actions">
            {progress.next && (
              <Button
                variant="action"
                className="owner-button"
                onClick={() => progress.next && onOpenStep(progress.next.id)}
              >
                <Icon name="buttonIcon" size={22} />
                {progress.next.label}
              </Button>
            )}
            {progress.review && (
              <Button
                variant="outline"
                className="owner-button"
                onClick={() => progress.review && onOpenStep(progress.review.id)}
              >
                <Icon name="buttonIcon" size={22} />
                {progress.review.label}
              </Button>
            )}
          </div>
        )}
      </section>

      <ol className="owner-steps" aria-label="Setup steps">
        {steps.map((step) => (
          <li key={step.id} className="owner-card owner-step">
            <div className="owner-step__top">
              <span className="owner-step__number">STEP {step.number}</span>
              {step.status && (
                <StatusLabel
                  text={step.status.text}
                  tone={step.status.tone}
                  icon={step.status.tone === 'success' ? 'stepCheck' : undefined}
                />
              )}
            </div>
            <div className="owner-step__text">
              <h3>{step.title}</h3>
              <p>{step.description}</p>
            </div>
            <div className="owner-step__action">
              <Button
                variant="outline"
                className="owner-button"
                disabled={step.action.disabled}
                onClick={() => onOpenStep(step.id)}
                aria-label={`${step.action.label}: ${step.title}`}
              >
                <Icon name="edit" size={22} />
                {step.action.label}
              </Button>
            </div>
          </li>
        ))}
      </ol>

      <div className="owner-row">
        <section className="owner-card owner-verify" aria-labelledby="owner-verify-title">
          <h2 id="owner-verify-title">Verified is not the same as published</h2>
          <div className="owner-verify__row">
            {setup.detailsVerified ? (
              <StatusLabel text="Verified" tone="success" />
            ) : (
              <StatusLabel text="Not verified" tone="warning" />
            )}
            <p>
              {setup.detailsVerified
                ? "We've checked your restaurant details. This does not make anything visible to diners."
                : 'We check your restaurant details before anything is shown to diners.'}
            </p>
          </div>
          <div className="owner-verify__row">
            {setup.published ? (
              <StatusLabel text="Published" tone="success" />
            ) : (
              <StatusLabel text="Not published" tone="warning" />
            )}
            <p>
              {setup.published
                ? 'Your menu is visible to diners.'
                : 'Your menu is not visible to diners yet. You decide when to publish.'}
            </p>
          </div>
        </section>
        <section className="owner-card owner-empty" aria-labelledby="owner-empty-title">
          <span className="owner-empty__tile">
            <Icon name="activity" size={24} />
          </span>
          <h2 id="owner-empty-title">No dish activity yet</h2>
          <p>
            Diner activity for your dishes will appear here once your menu is published and diners
            start using PeekaPlate. We never show placeholder numbers.
          </p>
        </section>
      </div>
    </OwnerShell>
  );
}
