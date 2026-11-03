// Owner Dashboard V2 (Simplified) demo shell: sidebar, top bar, AI panel/drawer, toast and the
// prototype controls that switch report states.
import { type ReactNode, useRef, useState } from 'react';
import logo from './assets/logo.png';
import { type Chat, ChatBox, CtxBar, type Message } from './chat';
import {
  type ActionState,
  ANSWERS,
  initialMenu,
  type MenuItem,
  newDraft,
  QUESTIONS,
  REST,
  route,
  type Scenario,
} from './data';
import { DishForm, type EditState, MenuList, Review, Saved } from './menu';
import {
  Actions,
  type Acts,
  DishDetail,
  Overview,
  type Page,
  Perf,
  Report,
  Welcome,
} from './pages';
import { BackChevron, Icon, type IconName } from './ui';

function Controls({
  sim,
  setSim,
  restart,
  showWelcome,
}: {
  sim: { scn: Scenario };
  setSim: (s: { scn: Scenario }) => void;
  restart: () => void;
  showWelcome: () => void;
}) {
  const [open, setOpen] = useState(false);
  const opts: [Scenario, string][] = [
    ['A', 'Normal report (Version A)'],
    ['B', 'Not enough data (Version B)'],
    ['C', 'Evidence check failed (Version C)'],
    ['empty', 'No data yet (empty state)'],
  ];
  return (
    <div className="pctl">
      {open && (
        <div className="pctl-p" role="group" aria-label="Prototype controls">
          <b>Prototype controls</b>
          <span className="muted" style={{ fontSize: 12.5 }}>
            Switch the report state to see each branch of the owner flow.
          </span>
          {opts.map(([k, l]) => (
            <label key={k}>
              <input
                type="radio"
                name="scn"
                checked={sim.scn === k}
                onChange={() => setSim({ scn: k })}
              />
              {l}
            </label>
          ))}
          <div className="row">
            <button type="button" className="btn sm" onClick={showWelcome}>
              Show welcome
            </button>
            <button type="button" className="btn sm" onClick={restart}>
              Restart
            </button>
          </div>
        </div>
      )}
      <button
        type="button"
        className="pctl-btn"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Prototype controls
      </button>
    </div>
  );
}

const NAV: [Page, string, IconName][] = [
  ['welcome', 'Restaurant Setup', 'store'],
  ['overview', 'Overview', 'home'],
  ['report', 'AI Insight Report', 'report'],
  ['perf', 'Dish performance', 'chart'],
  ['menu', 'Menu', 'menu'],
  ['actions', 'Actions', 'action'],
];

const wideNow = () => window.matchMedia('(min-width:901px)').matches;

export function App() {
  const [page, setPage] = useState<Page>('welcome');
  const [dishId, setDishId] = useState<string | null>(null);
  const [sim, setSim] = useState<{ scn: Scenario }>({ scn: 'A' });
  const [acts, setActs] = useState<Acts>({});
  const [menu, setMenu] = useState<MenuItem[]>(initialMenu);
  const [ed, setEd] = useState<EditState>({ step: 'list' });
  const [chatOpen, setChatOpen] = useState(false);
  const [threads, setThreads] = useState<Record<string, Message[]>>({ general: [], report: [] });
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [ctx, setCtx] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const idn = useRef(1);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const say = (t: string) => {
    setToast(t);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 2600);
  };
  const go = (p: Page) => {
    setPage(p);
    if (p === 'menu') setEd({ step: 'list' });
    setChatOpen(false);
    window.scrollTo(0, 0);
  };
  const openDish = (id: string) => {
    setDishId(id);
    setPage('dish');
    window.scrollTo(0, 0);
  };
  const setAct = (id: string, v: ActionState) => setActs((a) => ({ ...a, [id]: v }));
  const ask = (q: string, isKey?: boolean, tk = 'general') => {
    const key = isKey ? q : route(q) || 'cant';
    const text = isKey ? (QUESTIONS[q] ?? q) : q;
    setThreads((t) => ({
      ...t,
      [tk]: [...(t[tk] || []), { role: 'user', id: `u${idn.current++}`, text }],
    }));
    setBusyKey(tk);
    setTimeout(() => {
      const k = sim.scn === 'empty' ? 'empty' : key;
      const answer = (ANSWERS[k] ?? ANSWERS.cant)?.();
      if (answer)
        setThreads((t) => ({
          ...t,
          [tk]: [...(t[tk] || []), { role: 'ai', id: `a${idn.current++}`, ans: answer }],
        }));
      setBusyKey(null);
    }, 800);
  };
  const askInsight = (id: string) => {
    setCtx(id);
    setPage('report');
    setChatOpen(!wideNow());
    const tk = `ins:${id}`;
    if (!threads[tk]?.length) ask(`ins:${id}`, true, tk);
  };
  const openInsight = (id: string) => {
    setPage('report');
    setChatOpen(false);
    setTimeout(() => {
      const el = document.getElementById(`ins-${id}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      else window.scrollTo(0, 0);
    }, 120);
  };
  const chatFor = (tk: string): Chat => ({
    msgs: threads[tk] || [],
    busy: busyKey === tk,
    ask: (q, isKey) => {
      if (tk === 'report' && isKey && q.startsWith('ins:')) askInsight(q.slice(4));
      else ask(q, isKey, tk);
    },
  });
  const chat = chatFor('general');
  const openChat = () => {
    if (wideNow()) document.getElementById('chat-in-p')?.focus();
    else setChatOpen(true);
  };
  const panelTk = page === 'report' ? (ctx ? `ins:${ctx}` : 'report') : 'general';
  const panelChat = chatFor(panelTk);
  const ctxBar = page === 'report' && ctx ? <CtxBar ctx={ctx} askInsight={askInsight} /> : null;
  const editDish = (id: string, from?: string) => {
    const m = menu.find((x) => x.id === id);
    if (!m) return;
    setEd({ step: 'form', draft: { ...m, ing: [...m.ing] }, origId: id, from: from || null });
    setPage('menu');
    setChatOpen(false);
    window.scrollTo(0, 0);
  };
  const startAdd = () => {
    setEd({ step: 'form', draft: newDraft(), origId: null });
    window.scrollTo(0, 0);
  };
  const publish = (id: string) => {
    setMenu((ms) => ms.map((m) => (m.id === id ? { ...m, status: 'live' } : m)));
    setEd((e) => (e.step === 'saved' ? { ...e, saved: { ...e.saved, status: 'live' } } : e));
    say('Published to the diner menu');
  };
  const confirm = () => {
    if (ed.step !== 'review' && ed.step !== 'form') return;
    const dr = ed.draft;
    const rec: MenuItem = {
      ...dr,
      price: Number(dr.price),
      name: dr.name.trim(),
      id: dr.id || `new${idn.current++}`,
      status: 'ready',
      ing: dr.ing,
    };
    // Ingredients stay stored; the approval checkbox only controls what the review shows.
    if (dr.id) setMenu((ms) => ms.map((m) => (m.id === dr.id ? { ...rec, id: dr.id } : m)));
    else setMenu((ms) => [...ms, rec]);
    setEd({ step: 'saved', saved: rec });
  };
  const orig =
    (ed.step === 'form' || ed.step === 'review') && ed.origId
      ? (menu.find((m) => m.id === ed.origId) ?? null)
      : null;
  const toList = () => {
    setEd({ step: 'list' });
    window.scrollTo(0, 0);
  };

  let body: ReactNode = null;
  if (page === 'welcome') body = <Welcome go={go} />;
  else if (page === 'overview')
    body = <Overview go={go} sim={sim} acts={acts} openDish={openDish} openInsight={openInsight} />;
  else if (page === 'report') body = <Report go={go} acts={acts} setAct={setAct} />;
  else if (page === 'perf')
    body = <Perf sim={sim} openDish={openDish} chat={chat} openChat={openChat} />;
  else if (page === 'dish' && dishId)
    body = <DishDetail id={dishId} go={go} editDish={editDish} chat={chat} openChat={openChat} />;
  else if (page === 'actions')
    body = (
      <Actions
        acts={acts}
        setAct={setAct}
        editDish={editDish}
        sim={sim}
        openInsight={openInsight}
      />
    );
  else if (page === 'menu') {
    if (ed.step === 'list')
      body = (
        <MenuList
          menu={menu}
          startEdit={(id) => editDish(id)}
          startAdd={startAdd}
          publish={publish}
          acts={acts}
          openInsight={openInsight}
        />
      );
    else if (ed.step === 'form')
      body = (
        <DishForm
          ed={ed}
          setEd={setEd}
          orig={orig}
          cancel={toList}
          toReview={() => {
            setEd({ ...ed, step: 'review' });
            window.scrollTo(0, 0);
          }}
        />
      );
    else if (ed.step === 'review')
      body = (
        <Review
          ed={ed}
          orig={orig}
          back={() => setEd({ ...ed, step: 'form' })}
          confirm={confirm}
          cancel={() => {
            setEd({ step: 'list' });
            say('No changes saved');
            window.scrollTo(0, 0);
          }}
        />
      );
    else if (ed.step === 'saved') {
      const saved = ed.saved;
      const savedRec = menu.find((m) => m.id === saved.id) || saved;
      body = <Saved m={savedRec} publish={publish} backToMenu={() => go('menu')} />;
    }
  }
  if (['perf', 'actions'].includes(page) || (page === 'menu' && ed.step === 'list'))
    body = (
      <>
        <div className="backrow">
          <button type="button" className="back-link" onClick={() => go('overview')}>
            <BackChevron />
            Back to Dashboard
          </button>
        </div>
        {body}
      </>
    );
  const cur = page === 'dish' ? 'perf' : page;
  const restart = () => {
    setActs({});
    setMenu(initialMenu());
    setEd({ step: 'list' });
    setThreads({ general: [], report: [] });
    setCtx(null);
    setSim({ scn: 'A' });
    setPage('welcome');
    window.scrollTo(0, 0);
  };

  return (
    <div className="app has-ai">
      <aside className="side">
        <div className="brand">
          <img src={logo} alt="PeekaPlate logo" />
          <div>
            <b>PeekaPlate</b>
            <span>Owner Dashboard</span>
          </div>
        </div>
        <div className="rest">
          <b>{REST.name}</b>
          <span>Sample restaurant</span>
        </div>
        <nav className="nav" aria-label="Main">
          <div className="nav-label">Workspace</div>
          {NAV.map(([k, l, ic]) => (
            <button
              type="button"
              key={k}
              title={l}
              aria-current={cur === k ? 'page' : undefined}
              onClick={() => go(k)}
            >
              <Icon n={ic} s={19} />
              {l}
            </button>
          ))}
        </nav>
      </aside>
      <div className="main">
        <div className="topbar">
          <div className="l">
            <span className="chip sample">Illustrative sample data</span>
            <span className="chip">{REST.period}</span>
          </div>
          <button
            type="button"
            className="btn aibtn aibtn-top"
            onClick={() => setChatOpen(true)}
            aria-haspopup="dialog"
          >
            <span className="dot" />
            Ask AI
          </button>
        </div>
        <main id="content">{body}</main>
      </div>
      <aside className="aipanel" aria-label="PeekaPlate AI">
        <ChatBox chat={panelChat} panel ctxBar={ctxBar} />
      </aside>
      {chatOpen && (
        <div>
          <div className="scrim" onClick={() => setChatOpen(false)} />
          <div className="drawer-p" role="dialog" aria-label="Ask PeekaPlate AI">
            <ChatBox chat={panelChat} drawer onClose={() => setChatOpen(false)} ctxBar={ctxBar} />
          </div>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
      <Controls sim={sim} setSim={setSim} restart={restart} showWelcome={() => go('welcome')} />
    </div>
  );
}
