import { mountAnalyticsConsent } from '@peekaplate/analytics/consent';
import { StrictMode, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Card } from './ui';
import './style.css';

const root = document.getElementById('root');
if (!root) throw new Error('Staff console root element is missing');

function AnalyticsConsent() {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    return mountAnalyticsConsent(container.current, import.meta.env, 'console').dispose;
  }, []);
  return <div ref={container} />;
}

createRoot(root).render(
  <StrictMode>
    <main>
      <p className="eyebrow">PeekaPlate · Staff staging</p>
      <h1>A clear menu starts with trusted content.</h1>
      <p>
        The staff workspace is being prepared. Authentication, review and publication are not
        enabled yet.
      </p>
      <Card>
        <p>This environment contains no restaurant or customer records.</p>
        <Button variant="action">Save draft</Button>
      </Card>
      <AnalyticsConsent />
    </main>
  </StrictMode>,
);
