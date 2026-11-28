// Screen 9 Category field: Rania's "Owner / Category dropdown" (Figma 2985:15555, handoff
// 2991:15673). States: Default, Open – Empty, Creating, Open – Populated, Option hover, Selected.
// A select-only combobox: the field opens a list with "Add category" first, then the categories.
// "Add category" turns the list into a name input and an Add button; the new category then
// appears in the list for the owner to select. The categories live in the demo page's memory.
import { OWNER_DISH_DIETARY_MAX, type PublicMenuDietaryCode } from '@peekaplate/contracts';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import chevron from './assets/icons/angle-small-down.svg';
import check from './assets/icons/check.svg';
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

/** S09 Dietary options (Adam, Sprint 7 ticket 86bd5pnc2). */
export const DIETARY_LABELS: Record<PublicMenuDietaryCode, string> = {
  vegan: 'Vegan',
  vegetarian: 'Vegetarian',
  'gluten-free': 'Gluten-free',
};
const DIETARY_OPTIONS = Object.values(DIETARY_LABELS);

// Screen 9 Dietary field. No Figma frame exists yet, so it reuses the Category dropdown's field,
// menu and option styles (same tokens) as a multi-select list: clicking an option adds or removes
// it, and the other options are unavailable once two are chosen. Optional until required is confirmed.
export function DietaryField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: readonly string[];
  onChange: (labels: string[]) => void;
}) {
  const uid = useId();
  const listId = `${uid}-list`;
  const optionId = (option: string) => `${uid}-opt-${DIETARY_OPTIONS.indexOf(option)}`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const full = value.length >= OWNER_DISH_DIETARY_MAX;
  const blocked = (option: string) => full && !value.includes(option);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) fieldRef.current?.focus();
  };
  const toggle = (option: string) => {
    if (value.includes(option)) onChange(value.filter((label) => label !== option));
    else if (!full) onChange(DIETARY_OPTIONS.filter((o) => o === option || value.includes(o)));
  };

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  });

  const onFieldKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys: readonly string[] = DIETARY_OPTIONS;
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        setOpen(true);
        setActive(keys[0] ?? null);
      }
      return;
    }
    const at = active === null ? -1 : keys.indexOf(active);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = Math.min(
        keys.length - 1,
        Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)),
      );
      setActive(keys[next] ?? null);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActive((event.key === 'Home' ? keys[0] : keys.at(-1)) ?? null);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (active !== null) toggle(active);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab') {
      close(false);
    }
  };

  return (
    <div className="pp-field s09-cat">
      <span className="pp-field__label" id={`${uid}-label`}>
        Dietary Info
      </span>
      <div className="s09-cat__box" ref={boxRef}>
        <div
          ref={fieldRef}
          id={id}
          role="combobox"
          tabIndex={0}
          className="pp-input s09-cat__field"
          aria-labelledby={`${uid}-label ${uid}-value`}
          aria-describedby={`${uid}-hint`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && active !== null ? optionId(active) : undefined}
          data-open={open || undefined}
          onClick={() => (open ? close() : setOpen(true))}
          onKeyDown={onFieldKey}
        >
          <span id={`${uid}-value`} className={value.length ? undefined : 's09-cat__ph'}>
            {value.length ? value.join(', ') : 'Select dietary info'}
          </span>
          <img src={chevron} alt="" width={16} height={16} />
        </div>
        {open && (
          <div className="s09-cat__menu">
            <div
              role="listbox"
              id={listId}
              aria-labelledby={`${uid}-label`}
              aria-multiselectable="true"
            >
              {DIETARY_OPTIONS.map((option) => (
                <div
                  key={option}
                  role="option"
                  id={optionId(option)}
                  aria-selected={value.includes(option)}
                  aria-disabled={blocked(option) || undefined}
                  className="s09-cat__option"
                  data-active={(active === option && !blocked(option)) || undefined}
                  onMouseEnter={() => setActive(blocked(option) ? null : option)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => toggle(option)}
                >
                  {option}
                  {value.includes(option) && (
                    <img className="s09-diet__check" src={check} alt="" width={16} height={16} />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {/* Amr's S09 handoff: the helper shows while the list is closed and hides while it is open. */}
      <p className="pp-field__hint" id={`${uid}-hint`} hidden={open}>
        Select up to 2 options
      </p>
    </div>
  );
}
