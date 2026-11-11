// "PeekaPlate AI" chat for the demo. Answers are canned samples built from data.ts; nothing is
// sent to any model or server.
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { type Answer, INSIGHTS, QUESTIONS, QUICK, REST, SEC } from './data';
import { Btn, Icon, Lab } from './ui';

export type Message =
  | { role: 'user'; id: string; text: string }
  | { role: 'ai'; id: string; ans: Answer };
export type Chat = { msgs: Message[]; busy: boolean; ask: (q: string, isKey?: boolean) => void };

function AnswerView({ a }: { a: Answer }) {
  return (
    <div className="ans">
      <div className="head">
        <span className="av">AI</span>PeekaPlate AI <Lab k="st">Illustrative answer</Lab>{' '}
        <span className="lab good">Evidence check passed</span>
      </div>
      <p className="short">{a.short}</p>
      {a.secs.map((s) => (
        <div className="asec" key={s.k}>
          <div>
            <Lab k={s.k}>{SEC[s.k]}</Lab>
          </div>
          <ul>
            {s.items.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      ))}
      {a.ev.length > 0 && (
        <details className="ev">
          <summary>
            <Icon n="info" s={16} />
            Show evidence
          </summary>
          <ul>
            {a.ev.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function ChatBox({
  chat,
  drawer,
  onClose,
  embedded,
  panel,
  ctxBar,
}: {
  chat: Chat;
  drawer?: boolean;
  onClose?: () => void;
  embedded?: boolean;
  panel?: boolean;
  ctxBar?: ReactNode;
}) {
  const { msgs, busy, ask } = chat;
  const [v, setV] = useState('');
  const [more, setMore] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const ui = !!(panel || drawer);
  useEffect(() => {
    if (end.current) end.current.scrollTop = end.current.scrollHeight;
  }, [msgs.length, busy]);
  const last = [...msgs].reverse().find((m) => m.role === 'ai');
  const fups = (
    last && last.role === 'ai' && last.ans.follow.length ? last.ans.follow : QUICK
  ).slice(0, ui && !more ? 2 : 99);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!v.trim() || busy) return;
    ask(v.trim());
    setV('');
  };
  const inputId = drawer ? 'chat-in-d' : panel ? 'chat-in-p' : embedded ? 'chat-in-r' : 'chat-in';
  return (
    <div
      className={`chatbox${drawer ? ' drawer' : ''}${embedded ? ' embedded' : ''}${panel ? ' panel' : ''}${ui ? ' ai' : ''}`}
    >
      {ui && (
        <div className="aih">
          <div className="aih-top">
            <span className="aih-icon">
              <Icon n="spark" s={16} />
            </span>
            <h3>PeekaPlate AI</h3>
            {drawer && (
              <Btn
                kind="text"
                icon="x"
                type="button"
                onClick={onClose}
                aria-label="Close chat"
              ></Btn>
            )}
          </div>
          <div className="aih-chips">
            <span>{REST.name}</span>
            <span>{REST.period}</span>
          </div>
        </div>
      )}
      {ctxBar}
      <div
        className="msgs"
        ref={end}
        role="log"
        aria-live="polite"
        aria-label="Conversation with PeekaPlate AI"
      >
        {ui && (
          <p className="aih-intro">
            Ask about dish activity or the latest report. Answers use only the records shown on
            these pages.
          </p>
        )}
        {msgs.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="msg user">
              <div className="bubble">{m.text}</div>
            </div>
          ) : (
            <div key={m.id} className="msg">
              <AnswerView a={m.ans} />
            </div>
          ),
        )}
        {busy && (
          <div className="msg">
            <span className="typing" role="img" aria-label="PeekaPlate AI is writing">
              <i />
              <i />
              <i />
            </span>
          </div>
        )}
      </div>
      <div className="composer">
        {ui && (
          <div className="sq-head">
            <span>Suggested questions</span>
            <Btn kind="text" onClick={() => setMore((m) => !m)}>
              {more ? 'Show fewer questions' : 'Show more questions'}
            </Btn>
          </div>
        )}
        <div className="followups">
          {fups.map((k) => (
            <button
              type="button"
              key={k}
              className="qchip"
              disabled={busy}
              onClick={() => ask(k, true)}
            >
              {QUESTIONS[k]}
            </button>
          ))}
        </div>
        <form className="askform" onSubmit={submit}>
          <input
            id={inputId}
            aria-label="Ask a question about your menu"
            placeholder={
              ui
                ? 'Ask about your dishes or report…'
                : 'Ask about your dishes, e.g. “Which dishes get the most attention?”'
            }
            value={v}
            onChange={(e) => setV(e.target.value)}
          />
          {ui ? (
            <button
              className={`sendbtn${v.trim() ? ' on' : ''}`}
              type="submit"
              disabled={busy}
              aria-label="Ask"
            >
              <Icon n="send" s={17} />
            </button>
          ) : (
            <Btn kind="primary" size="lg" icon="send" type="submit" disabled={busy}>
              Ask
            </Btn>
          )}
        </form>
      </div>
    </div>
  );
}

export function CtxBar({ ctx, askInsight }: { ctx: string; askInsight: (id: string) => void }) {
  const ins = INSIGHTS.find((i) => i.id === ctx);
  return (
    <div className="ctxbar">
      {ins ? (
        <div className="ctx">
          <Lab k="obs">Context</Lab>
          <b>{ins.title}</b>
        </div>
      ) : (
        <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>
          Choose an insight to ask about it.
        </p>
      )}
      <div className="field">
        <label className="sr" htmlFor="ctx-sel">
          Insight for this conversation
        </label>
        <select
          id="ctx-sel"
          value={ctx || ''}
          onChange={(e) => {
            if (e.target.value) askInsight(e.target.value);
          }}
        >
          <option value="">Choose an insight</option>
          {INSIGHTS.map((i) => (
            <option key={i.id} value={i.id}>
              {i.title}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
