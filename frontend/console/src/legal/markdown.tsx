// Renders the owner legal documents (terms.md, privacy-policy.md) as React elements. It covers only
// the markdown those files use: headings, paragraphs, "-" lists (one level of nesting), tables, "---"
// and **bold** / *italic*. It never injects HTML, so text in the documents can't become markup.
import { Fragment, type ReactNode } from 'react';

type ListItem = { text: string; children: string[] };

export type Block =
  | { kind: 'heading'; level: 2 | 3 | 4; text: string }
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'list'; items: ListItem[] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'rule' };

export interface LegalDocument {
  title: string;
  blocks: Block[];
}

const LIST_ITEM = /^(\s*)- (.*)$/;

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

// The "# Title" line becomes the dialog title. Headings below it move down one level so the dialog
// keeps one h2: "##" renders as h3 and "###" as h4.
export function parseLegalMarkdown(source: string): LegalDocument {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let title = '';
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (trimmed === '') {
      i += 1;
      continue;
    }
    if (trimmed.startsWith('# ')) {
      title = trimmed.slice(2).trim();
      i += 1;
      continue;
    }
    const heading = /^(#{2,3}) (.*)$/.exec(trimmed);
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: heading[1] === '##' ? 3 : 4,
        text: (heading[2] ?? '').trim(),
      });
      i += 1;
      continue;
    }
    if (/^-{3,}$/.test(trimmed)) {
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }
    if (trimmed.startsWith('|')) {
      const head = cells(trimmed);
      const rows: string[][] = [];
      i += 1;
      // Skip the "| --- |" divider row.
      if (/^\|?[\s:|-]+\|?$/.test((lines[i] ?? '').trim())) i += 1;
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('|')) {
        rows.push(cells(lines[i] ?? ''));
        i += 1;
      }
      blocks.push({ kind: 'table', head, rows });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const items: ListItem[] = [];
      while (i < lines.length) {
        const match = LIST_ITEM.exec(lines[i] ?? '');
        if (!match) break;
        const nested = (match[1] ?? '').length > 0;
        const text = (match[2] ?? '').trim();
        const last = items.at(-1);
        if (nested && last) last.children.push(text);
        else items.push({ text, children: [] });
        i += 1;
      }
      blocks.push({ kind: 'list', items });
      continue;
    }
    // A paragraph runs until a blank line or the start of another block. Its lines keep their
    // breaks, so "Email:" and "Mail:" stay on separate lines.
    const paragraph: string[] = [];
    while (i < lines.length) {
      const next = lines[i] ?? '';
      const nextTrimmed = next.trim();
      if (
        nextTrimmed === '' ||
        nextTrimmed.startsWith('#') ||
        nextTrimmed.startsWith('|') ||
        /^-{3,}$/.test(nextTrimmed) ||
        LIST_ITEM.test(next)
      ) {
        break;
      }
      paragraph.push(nextTrimmed);
      i += 1;
    }
    blocks.push({ kind: 'paragraph', lines: paragraph });
  }

  return { title, blocks };
}

// **bold** and *italic*, the only inline styles the documents use.
export function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  let last = 0;
  let key = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1] !== undefined) nodes.push(<strong key={key++}>{match[1]}</strong>);
    else nodes.push(<em key={key++}>{match[2]}</em>);
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderBlock(block: Block, index: number): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const Tag = `h${block.level}` as const;
      return <Tag key={index}>{renderInline(block.text)}</Tag>;
    }
    case 'paragraph':
      return (
        <p key={index}>
          {block.lines.map((line, n) => (
            <Fragment key={n}>
              {n > 0 && <br />}
              {renderInline(line)}
            </Fragment>
          ))}
        </p>
      );
    case 'list':
      return (
        <ul key={index}>
          {block.items.map((item, n) => (
            <li key={n}>
              {renderInline(item.text)}
              {item.children.length > 0 && (
                <ul>
                  {item.children.map((child, m) => (
                    <li key={m}>{renderInline(child)}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div key={index} className="pp-legal__table">
          <table>
            <thead>
              <tr>
                {block.head.map((cell, n) => (
                  <th key={n} scope="col">
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, n) => (
                <tr key={n}>
                  {row.map((cell, m) => (
                    <td key={m}>{renderInline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'rule':
      return <hr key={index} />;
  }
}

export function LegalBody({ blocks }: { blocks: Block[] }) {
  return <>{blocks.map(renderBlock)}</>;
}
