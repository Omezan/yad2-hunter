'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from 'react';
import { solidPillStyle } from '../lib/district-colors';

type ScanOption = { value: string; label: string };
type ScanOptionGroup = { key: string; title: string; options: ScanOption[] };

// Mirrors the order/labels in src/config/searches.js. Kept hardcoded
// here so the picker renders before /api/state has loaded — watches
// without any ads yet still appear as selectable. Grouped into the
// three product surfaces (main dashboard, /lev-hapark, /rent-in-cities)
// so the section header tells the user where the results will appear
// when they pick a watch.
export const SCAN_OPTION_GROUPS: ScanOptionGroup[] = [
  {
    key: 'moshav',
    title: 'מושבים',
    options: [
      { value: 'jerusalem', label: 'ירושלים והסביבה' },
      { value: 'center-sharon', label: 'מרכז והשרון' },
      { value: 'south', label: 'דרום' },
      { value: 'coastal-north', label: 'חוף צפוני' },
      { value: 'north-valleys', label: 'צפון והעמקים' }
    ]
  },
  {
    key: 'lev-hapark',
    title: 'לב הפארק, רעננה',
    options: [
      { value: 'lev-hapark-rent', label: 'לב הפארק — שכירות' },
      { value: 'lev-hapark-sale', label: 'לב הפארק — מכירה' }
    ]
  },
  {
    key: 'rent-in-cities',
    title: 'שכירות בערים',
    options: [{ value: 'rent-in-cities', label: 'שכירות בערים — מרכז ושרון' }]
  }
];

// Back-compat alias for older importers; new code should use
// SCAN_OPTION_GROUPS so it stays aware of the visual sectioning.
export const SCAN_DISTRICT_OPTIONS: ScanOption[] = SCAN_OPTION_GROUPS.flatMap(
  (group) => group.options
);

type Props = {
  /** Visible label rendered on the trigger button. */
  label: string;
  /** Disable the trigger button entirely (e.g. cooldown / pending). */
  disabled?: boolean;
  /** Tooltip on the trigger button. */
  title?: string;
  /**
   * Called when the user clicks "הרץ" inside the picker. The empty
   * array means "scan everything" (the workflow handles that). The
   * second argument is the required rent budget (₪) to use for this run.
   */
  onSubmit: (searchIds: string[], maxPrice: number) => void;
};

// Budget field bounds. Kept in sync with the API route's clamp
// (dashboard/app/api/trigger/scan/route.ts) so the client and server
// agree on what a valid budget is.
const DEFAULT_BUDGET = 9500;
const MIN_BUDGET = 1000;
const MAX_BUDGET = 100000;

export default function ScanPicker({ label, disabled, title, onSubmit }: Props) {
  const [open, setOpen] = useState(false);
  const allValues = useMemo(
    () => SCAN_OPTION_GROUPS.flatMap((group) => group.options.map((o) => o.value)),
    []
  );
  const [selected, setSelected] = useState<Set<string>>(() => new Set(allValues));
  const [budget, setBudget] = useState<string>(String(DEFAULT_BUDGET));
  const ref = useRef<HTMLDivElement | null>(null);

  const budgetValue = Number.parseInt(budget, 10);
  const budgetValid =
    Number.isFinite(budgetValue) &&
    budgetValue >= MIN_BUDGET &&
    budgetValue <= MAX_BUDGET;

  useEffect(() => {
    if (!open) return;
    const onDocumentClick = (e: MouseEvent) => {
      if (!ref.current) return;
      if (ref.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocumentClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocumentClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (typeof window === 'undefined') return;
    if (!window.matchMedia('(max-width: 600px)').matches) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const toggle = useCallback((value: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(value)) {
        next.delete(value);
      } else {
        next.add(value);
      }
      return next;
    });
  }, []);

  const allSelected = selected.size === allValues.length;
  const noneSelected = selected.size === 0;

  const triggerLabel = (() => {
    if (disabled) return label;
    if (allSelected) return label;
    if (noneSelected) return `${label} (בחר חיפוש)`;
    return `${label} (${selected.size})`;
  })();

  const handleSubmit = () => {
    if (noneSelected || !budgetValid) return;
    setOpen(false);
    // "all selected" is the cron-equivalent path: send an empty list so
    // the worker treats it as "scan everything", which keeps the
    // default Telegram suppression (north-valleys) in place. A strict
    // subset is forwarded as an explicit list, which also bypasses
    // suppression for any of those districts that are normally muted.
    onSubmit(allSelected ? [] : Array.from(selected), budgetValue);
  };

  return (
    <div
      ref={ref}
      className={`scan-picker toolbar-district ${open ? 'is-open' : ''}`}
    >
      <button
        type="button"
        className="primary scan-picker-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        {triggerLabel}
        <span className="toolbar-district-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open ? (
        <>
          <div
            className="toolbar-district-backdrop"
            aria-hidden="true"
            onClick={() => setOpen(false)}
          />
          <div
            className="toolbar-district-popover scan-picker-popover"
            role="dialog"
            aria-modal="true"
          >
            <div className="toolbar-district-header">
              <span className="toolbar-district-title">בחירת חיפושים לסריקה</span>
              <button
                type="button"
                className="toolbar-district-close"
                aria-label="סגור"
                onClick={() => setOpen(false)}
              >
                ✕
              </button>
            </div>

            <div className="scan-picker-budget">
              <label className="scan-picker-budget-label" htmlFor="scan-picker-budget-input">
                תקציב מקסימלי (₪)
              </label>
              <input
                id="scan-picker-budget-input"
                className={`scan-picker-budget-input${budgetValid ? '' : ' is-invalid'}`}
                type="number"
                inputMode="numeric"
                min={MIN_BUDGET}
                max={MAX_BUDGET}
                step={100}
                required
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                placeholder={String(DEFAULT_BUDGET)}
              />
              {!budgetValid ? (
                <span className="scan-picker-budget-hint">
                  יש להזין תקציב בין {MIN_BUDGET.toLocaleString('he-IL')} ל-
                  {MAX_BUDGET.toLocaleString('he-IL')}₪
                </span>
              ) : null}
            </div>

            <div className="toolbar-district-actions">
              <button
                type="button"
                className="toolbar-district-link"
                onClick={() =>
                  setSelected(allSelected ? new Set() : new Set(allValues))
                }
              >
                {allSelected ? 'נקה הכל' : 'בחר הכל'}
              </button>
            </div>

            <div className="scan-picker-groups">
              {SCAN_OPTION_GROUPS.map((group) => (
                <div
                  key={group.key}
                  className="scan-picker-group"
                  role="group"
                  aria-label={group.title}
                >
                  <div className="scan-picker-group-title">{group.title}</div>
                  <div
                    className="toolbar-district-list scan-picker-group-list"
                    role="listbox"
                    aria-multiselectable="true"
                  >
                    {group.options.map((option) => {
                      const active = selected.has(option.value);
                      const style: CSSProperties = solidPillStyle(
                        option.value,
                        active
                      );
                      return (
                        <button
                          type="button"
                          key={option.value}
                          role="option"
                          aria-selected={active}
                          className={`pill pill-district ${active ? 'is-active' : ''}`}
                          style={style}
                          onClick={() => toggle(option.value)}
                        >
                          <span className="scan-picker-check" aria-hidden="true">
                            {active ? '✓' : ''}
                          </span>
                          <span>{option.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <div className="toolbar-district-footer scan-picker-footer">
              <button
                type="button"
                className="toolbar-district-done"
                onClick={handleSubmit}
                disabled={noneSelected || !budgetValid}
              >
                {allSelected
                  ? 'הרץ סריקה לכל החיפושים'
                  : `הרץ סריקה (${selected.size})`}
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
