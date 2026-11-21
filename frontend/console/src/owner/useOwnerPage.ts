import { useCallback, useEffect, useRef, useState } from 'react';
import { OWNER_PAGE_PATHS, ownerPageForPath } from './routes';
import type { OwnerPage } from './setup';

function historyIndex(): number | undefined {
  const value = window.history.state?.ownerPageIndex;
  return Number.isSafeInteger(value) ? value : undefined;
}

export function useOwnerPage(
  enabled: boolean,
  canLeave: () => boolean,
  onHistoryNavigation: () => void,
) {
  const [page, setPage] = useState<OwnerPage>(
    () => (enabled && ownerPageForPath(window.location.pathname)) || 'setup',
  );
  const entry = useRef({ page, index: historyIndex() ?? 0 });
  const navigate = useCallback(
    (next: OwnerPage, mode: 'push' | 'replace' = 'push') => {
      if (enabled) {
        const path = OWNER_PAGE_PATHS[next];
        const index = historyIndex();
        if (window.location.pathname !== path && mode === 'push') {
          entry.current = { page: next, index: entry.current.index + 1 };
          window.history.pushState({ ownerPageIndex: entry.current.index }, '', path);
        } else {
          entry.current = { page: next, index: index ?? entry.current.index };
          if (window.location.pathname !== path || index === undefined)
            window.history.replaceState({ ownerPageIndex: entry.current.index }, '', path);
        }
      }
      setPage(next);
    },
    [enabled],
  );

  useEffect(() => {
    if (!enabled) return;
    function onPopState() {
      const next = ownerPageForPath(window.location.pathname);
      const current = entry.current;
      const index = historyIndex();
      if (next === current.page) {
        // The skip-to-content anchor creates its own history entry.
        current.index = index ?? current.index + 1;
        if (index === undefined) window.history.replaceState({ ownerPageIndex: current.index }, '');
        return;
      }
      if (!canLeave()) {
        if (index !== undefined && current.index !== index)
          window.history.go(current.index - index);
        else navigate(current.page, 'replace');
        return;
      }
      navigate(next ?? 'setup', 'replace');
      onHistoryNavigation();
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [canLeave, enabled, navigate, onHistoryNavigation]);

  return [page, navigate] as const;
}
