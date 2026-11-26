import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchOwnerReport } from '../owner-dashboard/report-api';
import { ReportView } from '../owner-dashboard/report-data';
import { UNEEZA_REPORT } from '../owner-dashboard/uneeza-report';
import { LiveDashboardReport } from './OwnerWorkspace';

const VENUE_A = UNEEZA_REPORT.venue_id;
const VENUE_B = '22222222-2222-4222-8222-222222222222';

function buildReport({
  venueId,
  openRate,
  isStale = false,
  windowStart = '2026-11-24T11:50:00.000Z',
  windowEnd = '2026-11-24T11:55:00.000Z',
}: {
  venueId: string;
  openRate: number;
  isStale?: boolean | null;
  windowStart?: string;
  windowEnd?: string;
}) {
  return {
    ...UNEEZA_REPORT,
    venue_id: venueId,
    report_metadata: {
      ...UNEEZA_REPORT.report_metadata,
      generated_at: windowEnd,
      date_window: { start_time: windowStart, end_time: windowEnd, duration_hours: 1 },
      freshness: { last_event_ingested_at: windowEnd, is_stale: isStale },
    },
    dishes: [
      {
        ...UNEEZA_REPORT.dishes[1],
        name: venueId === VENUE_A ? 'Venue A Lentil Bowl' : 'Venue B Saffron Rice',
        metrics: {
          ...UNEEZA_REPORT.dishes[1].metrics,
          active_sessions: { value: venueId === VENUE_A ? 14 : 16, status: 'NORMAL' as const },
          open_rate: { value: openRate, status: 'NORMAL' as const },
        },
      },
    ],
  };
}

function jsonRes(body: unknown, status = 200, ref = 'ref-1') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Owner-Report-Ref': ref },
  });
}

type MiniNode = {
  nodeType: number;
  tagName?: string;
  textContent: string;
  value?: string;
  childNodes: MiniNode[];
  parentNode: MiniNode | null;
  style: Record<string, string>;
  attributes: Record<string, string>;
  id?: string;
  appendChild: (child: MiniNode) => MiniNode;
  insertBefore: (child: MiniNode, ref: MiniNode | null) => MiniNode;
  removeChild: (child: MiniNode) => MiniNode;
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  addEventListener: () => void;
  removeEventListener: () => void;
  focus: () => void;
  getAttribute: (name: string) => string | null;
};

function installDomStub() {
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevAct = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  let docRef: Record<string, unknown> = {};
  const docState: { activeElement: MiniNode | null; body: MiniNode } = {
    activeElement: null,
    body: null as unknown as MiniNode,
  };

  class FakeElement {}
  const makeNode = (nodeType: number, tagName?: string, text = ''): MiniNode => {
    const node = Object.assign(new FakeElement(), {
      nodeType,
      tagName,
      get ownerDocument() { return docRef; },
      textContent: text,
      value: '',
      childNodes: [],
      parentNode: null,
      style: { setProperty(k: string, v: string) { (this as Record<string, unknown>)[k] = v; }, removeProperty(k: string) { delete (this as Record<string, unknown>)[k]; } } as unknown as Record<string, string>,
      attributes: {},
      appendChild(child: MiniNode) {
        if (child.parentNode) child.parentNode.removeChild(child);
        if (child.nodeType === 11) {
          for (const nested of [...child.childNodes]) node.appendChild(nested);
          return child;
        }
        child.parentNode = node;
        node.childNodes.push(child);
        return child;
      },
      insertBefore(child: MiniNode, ref: MiniNode | null) {
        if (!ref) return node.appendChild(child);
        if (child.parentNode) child.parentNode.removeChild(child);
        if (child.nodeType === 11) {
          for (const nested of [...child.childNodes]) node.insertBefore(nested, ref);
          return child;
        }
        const idx = node.childNodes.indexOf(ref);
        child.parentNode = node;
        if (idx === -1) node.childNodes.push(child);
        else node.childNodes.splice(idx, 0, child);
        return child;
      },
      removeChild(child: MiniNode) {
        const idx = node.childNodes.indexOf(child);
        if (idx !== -1) node.childNodes.splice(idx, 1);
        child.parentNode = null;
        if (docState.activeElement === child) docState.activeElement = docState.body;
        return child;
      },
      setAttribute(name: string, value: string) {
        node.attributes[name] = String(value);
        if (name === 'id') node.id = String(value);
        if (name === 'value') node.value = String(value);
      },
      removeAttribute(name: string) {
        delete node.attributes[name];
      },
      getAttribute(name: string) {
        return name in node.attributes ? node.attributes[name] : null;
      },
      addEventListener() {},
      removeEventListener() {},
      focus() {
        docState.activeElement = node;
      },
    }) as unknown as MiniNode;
    return node;
  };
  const findById = (root: MiniNode, id: string): MiniNode | null => {
    if (root.id === id) return root;
    for (const child of root.childNodes) {
      const found = findById(child, id);
      if (found) return found;
    }
    return null;
  };

  const serializeText = (node: MiniNode): string => {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType === 8) return '';
    const aria = node.attributes['aria-label'] ? ' ' + node.attributes['aria-label'] : '';
    return (node.childNodes.map(serializeText).join(' ') + aria).trim();
  };

  const body = makeNode(1, 'BODY');
  docState.body = body;
  docState.activeElement = body;

  const doc = {
    defaultView: null as unknown,
    nodeType: 9,
    body,
    visibilityState: 'visible',
    get activeElement() {
      return docState.activeElement;
    },
    createElement: (tag: string) => makeNode(1, tag.toUpperCase()),
    createElementNS: (_ns: string, tag: string) => makeNode(1, tag.toUpperCase()),
    createTextNode: (text: string) => makeNode(3, undefined, String(text)),
    createComment: (text: string) => makeNode(8, undefined, String(text)),
    createDocumentFragment: () => makeNode(11),
    getElementById: (id: string) => findById(body, id),
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  docRef = doc;
  const win = {
    HTMLIFrameElement: class HTMLIFrameElement {},
    HTMLElement: FakeElement,
    Element: FakeElement,
    Node: FakeElement,
    document: doc,
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('document', doc);
  doc.defaultView = win;
  vi.stubGlobal('window', win);
  vi.stubGlobal('HTMLElement', FakeElement);
  vi.stubGlobal('Element', FakeElement);

  return {
    container: body,
    readText: () => serializeText(body).replace(/\s+/g, ' ').trim(),
    findInput: () => findById(body, 'unsaved-draft-input'),
    restore: () => {
      (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = prevAct;
      if (prevWindow === undefined) delete (globalThis as Record<string, unknown>).window;
      else vi.stubGlobal('window', prevWindow);
      if (prevDocument === undefined) delete (globalThis as Record<string, unknown>).document;
      else vi.stubGlobal('document', prevDocument);
    },
  };
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('S7-RES-07 dashboard refresh, venue isolation, and cutover checks', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reloads LiveDashboardReport in place on reloadAttempt without unmounting or resetting focus/unsaved edits', async () => {
    const dom = installDomStub();
    let aCalls = 0;
    const seenRefs: Array<string | undefined> = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(VENUE_A)) {
        aCalls += 1;
        return aCalls === 1
          ? jsonRes(buildReport({ venueId: VENUE_A, openRate: 10 / 14 }), 200, 'ref-a1')
          : jsonRes(buildReport({ venueId: VENUE_A, openRate: 11 / 14 }), 200, 'ref-a2');
      }
      return jsonRes(buildReport({ venueId: VENUE_B, openRate: 12 / 16 }), 200, 'ref-b1');
    });
    vi.stubGlobal('fetch', fetchMock);

    function Harness({ reloadAttempt }: { reloadAttempt: number }) {
      const [draftNote, setDraftNote] = useState('Unpublished dish note');
      return (
        <div>
          <input
            id="unsaved-draft-input"
            value={draftNote}
            onChange={(e) => setDraftNote(e.target.value)}
          />
          <LiveDashboardReport
            reloadAttempt={reloadAttempt}
            page="performance"
            apiBase="https://example.test"
            venueId={VENUE_A}
            restaurantName="Venue A"
            menu={[]}
            getAccessToken={async () => 'tok'}
            onAccessFailure={() => {}}
            onReport={(_report, ref) => {
              if (ref) seenRefs.push(ref);
            }}
            go={() => {}}
          />
        </div>
      );
    }

    const host = dom.container.appendChild(document.createElement('div') as unknown as MiniNode);
    const root = createRoot(host as unknown as Element);

    try {
      await act(async () => {
        root.render(<Harness reloadAttempt={0} />);
      });
      await flushMicrotasks();

      expect(aCalls).toBe(1);
      expect(dom.readText()).toContain('0.7142857142857143');
      expect(seenRefs).toContain('ref-a1');

      const input = dom.findInput();
      expect(input).not.toBeNull();
      input?.focus();
      expect(document.activeElement).toBe(input);

      await act(async () => {
        root.render(<Harness reloadAttempt={1} />);
      });
      expect(dom.readText()).not.toContain('Loading report…');
      await flushMicrotasks();

      expect(aCalls).toBe(2);
      expect(dom.readText()).toContain('0.7857142857142857');
      expect(dom.readText()).not.toContain('0.7142857142857143');
      expect(seenRefs).toContain('ref-a2');
      expect(document.activeElement).toBe(input);
      expect(dom.findInput()?.value).toBe('Unpublished dish note');
    } finally {
      await act(async () => {
        root.unmount();
      });
      dom.restore();
    }
  }, 30_000);
  it('uses useOwnerReport abort guard so delayed A responses never leak after switching to B', async () => {
    const dom = installDomStub();
    let aSignalAborted = false;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(VENUE_A)) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aSignalAborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }
      return Promise.resolve(
        jsonRes(buildReport({ venueId: VENUE_B, openRate: 12 / 16 }), 200, 'ref-b-fast'),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const host = dom.container.appendChild(document.createElement('div') as unknown as MiniNode);
    const root = createRoot(host as unknown as Element);

    try {
      await act(async () => {
        root.render(
          <LiveDashboardReport
            key={`owner:${VENUE_A}`}
            reloadAttempt={0}
            page="performance"
            apiBase="https://example.test"
            venueId={VENUE_A}
            restaurantName="Venue A"
            menu={[]}
            getAccessToken={async () => 'tok'}
            onAccessFailure={() => {}}
            onReport={() => {}}
            go={() => {}}
          />,
        );
      });
      await flushMicrotasks();
      expect(aSignalAborted).toBe(false);

      await act(async () => {
        root.render(
          <LiveDashboardReport
            key={`owner:${VENUE_B}`}
            reloadAttempt={0}
            page="performance"
            apiBase="https://example.test"
            venueId={VENUE_B}
            restaurantName="Venue B"
            menu={[]}
            getAccessToken={async () => 'tok'}
            onAccessFailure={() => {}}
            onReport={() => {}}
            go={() => {}}
          />,
        );
      });
      await flushMicrotasks();

      expect(aSignalAborted).toBe(true);
      expect(dom.readText()).toContain('0.75');
      expect(dom.readText()).toContain('Venue B Saffron Rice');
      expect(dom.readText()).not.toContain('Venue A Lentil Bowl');
    } finally {
      await act(async () => {
        root.unmount();
      });
      dom.restore();
    }
  }, 30_000);

  it('handles stale data, daily UTC cutover, and 403 access revocation', async () => {
    const dom = installDomStub();
    let accessFailureKind: string | null = null;

    const fetchMock = vi.fn(async () =>
      jsonRes({ error: 'forbidden' }, 403, 'ref-denied'),
    );
    vi.stubGlobal('fetch', fetchMock);

    const host = dom.container.appendChild(document.createElement('div') as unknown as MiniNode);
    const root = createRoot(host as unknown as Element);

    try {
      const staleReport = buildReport({
        venueId: VENUE_A,
        openRate: 10 / 14,
        isStale: true,
        windowStart: '2026-11-24T00:00:00.000Z',
        windowEnd: '2026-11-24T23:55:00.000Z',
      });
      await act(async () => {
        root.render(<ReportView state={{ kind: 'ready', report: staleReport }} presentation="performance" />);
      });
      expect(dom.readText()).toContain('out of date');

      const cutoverReport = buildReport({
        venueId: VENUE_A,
        openRate: 11 / 14,
        isStale: false,
        windowStart: '2026-11-25T00:00:00.000Z',
        windowEnd: '2026-11-25T00:05:00.000Z',
      });
      await act(async () => {
        root.render(<ReportView key="cutover" state={{ kind: 'ready', report: cutoverReport }} presentation="performance" />);
      });
      expect(dom.readText()).toContain('up to date');
      expect(dom.readText()).toContain('0.7857142857142857');

      const revoked = await fetchOwnerReport({
        apiBase: 'https://example.test',
        venueId: VENUE_A,
        accessToken: 'revoked-tok',
        fetch: fetchMock,
      });
      expect(revoked).toEqual({ kind: 'denied' });

      await act(async () => {
        root.render(
          <LiveDashboardReport
            reloadAttempt={0}
            page="performance"
            apiBase="https://example.test"
            venueId={VENUE_A}
            restaurantName="Venue A"
            menu={[]}
            getAccessToken={async () => 'revoked-tok'}
            onAccessFailure={(kind) => {
              accessFailureKind = kind;
            }}
            onReport={() => {}}
            go={() => {}}
          />,
        );
      });
      await flushMicrotasks();
      expect(accessFailureKind).toBe('denied');
    } finally {
      await act(async () => {
        root.unmount();
      });
      dom.restore();
    }
  }, 30_000);
});
