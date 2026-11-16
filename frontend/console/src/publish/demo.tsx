// Preview-only demo of S13 (menu preview and publish), built only for PR previews. It shows the
// normal flow with no demo controls: Publish Menu, the confirmation, then "Your menu is live" with
// an example link. Nothing is sent or published. The phone shows the same build's diner preview.
// The Not Ready and failed-publish states are covered by MenuPreview's unit tests.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../style.css';
import { dinerPreviewUrl } from './diner-url';
import { MenuPreview } from './MenuPreview';

const root = document.getElementById('root');
if (!root) throw new Error('Menu preview demo root element is missing');

// Fictional restaurant; the URL stands in for the one the publish API returns.
const RESTAURANT = 'Ember & Stone';
const SAMPLE_URL = 'https://peekaplate.app/diner/ember-stone';
const DELAY_MS = 900;

function Demo() {
  const [publishing, setPublishing] = useState(false);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);
  const [run, setRun] = useState(0);

  const publish = () => {
    setPublishing(true);
    window.setTimeout(() => {
      setPublishing(false);
      setPublishedUrl(SAMPLE_URL);
    }, DELAY_MS);
  };
  // Leaving the screen starts the demo again.
  const restart = () => {
    setPublishing(false);
    setPublishedUrl(null);
    setRun((n) => n + 1);
  };

  return (
    <MenuPreview
      key={run}
      restaurantName={RESTAURANT}
      dishCount={7}
      categoryCount={3}
      dinerUrl={dinerPreviewUrl(window.location)}
      publishing={publishing}
      publishedUrl={publishedUrl}
      onBackToEdit={restart}
      onReviewDishes={restart}
      onPublish={publish}
      onGoToDashboard={restart}
    />
  );
}

createRoot(root).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
