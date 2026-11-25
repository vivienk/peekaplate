// Screen 9 Category field: Rania's "Owner / Category dropdown" (Figma 2985:15555, handoff
// 2991:15673). States: Default, Open – Empty, Creating, Open – Populated, Option hover, Selected.
// A select-only combobox: the field opens a list with "Add category" first, then the categories.
// "Add category" turns the list into a name input and an Add button; the new category then
// appears in the list for the owner to select. The categories live in the demo page's memory.
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import chevron from './assets/icons/angle-small-down.svg';
import plus from './assets/icons/plus-small.svg';
import { Btn } from './controls';

/**
 * One Category list from several sources (saved dishes, the owner's new categories): trimmed,
 * blanks dropped, and each name once regardless of case, keeping the first spelling and order.
 */
export function mergeCategories(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const name of lists.flat()) {
    const text = name.trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    merged.push(text);
  }
  return merged;
}

const ADD = Symbol('add-category');
type CategoryKey = string | typeof ADD;

export function CategoryField({
  id,
  value,
  categories,
  onSelect,
  onAddCategory,
  error,
}: {
  id: string;
  value: string;
  categories: string[];
  onSelect: (category: string) => void;
  onAddCategory: (category: string) => void;
  /** The field's error text, shown under it by the caller. */
  error?: string | undefined;
}) {
  const uid = useId();
  const listId = `${uid}-list`;
  const optionId = (key: CategoryKey) =>
    `${uid}-opt-${key === ADD ? 'add' : categories.indexOf(key)}`;
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  // The highlighted row (Option hover style): none until the pointer or the arrow keys pick one.
  const [active, setActive] = useState<CategoryKey | null>(null);
  const [name, setName] = useState('');
  const fieldRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const keys: CategoryKey[] = [ADD, ...categories];

  const close = (refocus = true) => {
    setOpen(false);
    setCreating(false);
    setName('');
    if (refocus) fieldRef.current?.focus();
  };
  // From the keyboard the highlight starts on the chosen category (or the first row); from the
  // pointer nothing is highlighted until it moves over a row.
  const openList = (fromKeyboard: boolean) => {
    setOpen(true);
    setCreating(false);
    setActive(fromKeyboard ? (categories.includes(value) ? value : ADD) : null);
  };
  const choose = (key: CategoryKey) => {
    if (key === ADD) {
      setCreating(true);
      return;
    }
    onSelect(key);
    close();
  };
  const add = () => {
    const text = name.trim();
    // Empty, duplicate and maximum-length rules are TBD in the handoff; an empty name is ignored and
    // an existing name (any case) is reused rather than added twice.
    if (!text) return;
    const existing = categories.find((c) => c.toLowerCase() === text.toLowerCase());
    if (!existing) onAddCategory(text);
    setCreating(false);
    setName('');
    setActive(existing ?? text);
    fieldRef.current?.focus();
  };

  // Clicking outside closes the list.
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  });

  const onFieldKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const move = (step: number) => {
      const at = active === null ? (step > 0 ? -1 : keys.length) : keys.indexOf(active);
      setActive(keys[Math.min(keys.length - 1, Math.max(0, at + step))] ?? ADD);
    };
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        openList(true);
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActive((event.key === 'Home' ? keys[0] : keys.at(-1)) ?? ADD);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (active !== null) choose(active);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab') {
      close(false);
    }
  };

  const listOpen = open && !creating;
  return (
    <div className="pp-field s09-cat">
      <span className="pp-field__label" id={`${uid}-label`}>
        Category
      </span>
      <div className="s09-cat__box" ref={boxRef}>
        <div
          ref={fieldRef}
          id={id}
          role="combobox"
          tabIndex={0}
          className="pp-input s09-cat__field"
          aria-labelledby={`${uid}-label ${uid}-value`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          aria-required="true"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          aria-activedescendant={listOpen && active !== null ? optionId(active) : undefined}
          data-open={open || undefined}
          onClick={() => (open ? close() : openList(false))}
          onKeyDown={onFieldKey}
        >
          <span id={`${uid}-value`} className={value ? undefined : 's09-cat__ph'}>
            {value || 'Select category'}
          </span>
          <img src={chevron} alt="" width={16} height={16} />
        </div>
        {open && (
          <div className="s09-cat__menu">
            {creating ? (
              <div className="s09-cat__new">
                <input
                  className="pp-input"
                  aria-label="New category name"
                  placeholder="Enter category name"
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      add();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      close();
                    }
                  }}
                />
                <Btn kind="outlined" size="md" type="button" onClick={add}>
                  Add
                </Btn>
              </div>
            ) : (
              <div role="listbox" id={listId} aria-labelledby={`${uid}-label`}>
                <div
                  role="option"
                  id={optionId(ADD)}
                  aria-selected={false}
                  className="s09-cat__option s09-cat__add"
                  data-active={active === ADD || undefined}
                  onMouseEnter={() => setActive(ADD)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(ADD)}
                >
                  <img src={plus} alt="" width={16} height={16} />
                  Add category
                </div>
                {categories.length > 0 && <div className="s09-cat__divider" aria-hidden="true" />}
                {categories.map((category) => (
                  <div
                    key={category}
                    role="option"
                    id={optionId(category)}
                    aria-selected={category === value}
                    className="s09-cat__option"
                    data-active={active === category || undefined}
                    onMouseEnter={() => setActive(category)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(category)}
                  >
                    {category}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
