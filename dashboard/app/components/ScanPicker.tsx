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

// Mirrors the order/labels in src/config/searches.js. Kept hardcoded
// here so the picker renders before /api/state has loaded — districts
// without any ads yet still appear as selectable.
export const SCAN_DISTRICT_OPTIONS: { value: string; label: string }[] = [
  { value: 'jerusalem', label: 'ירושלים והסביבה' },
  { value: 'center-sharon', label: 'מרכז והשרון' },
  { value: 'south', label: 'דרום' },
  { value: 'coastal-north', label: 'חוף צפוני' },
  { value: 'north-valleys', label: 'צפון והעמקים' }
];

type Props = {
  /** Visible label rendered on the trigger button. */
  label: string;
  /** Disable the trigger button entirely (e.g. cooldown / pending). */
  disabled?: boolean;
  /** Tooltip on the trigger button. */
  title?: string;
  /**
   * Called when the user clicks "הרץ" inside the picker. The empty
   * array means "scan everything" (the workflow handles that).
   */
  onSubmit: (searchIds: string[]) => void;
};

export default function ScanPicker({ label, disabled, title, onSubmit }: Props) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(SCAN_DISTRICT_OPTIONS.map((o) => o.value))
  );
  const ref = useRef<HTMLDivElement | null>(null);

  // Close on outside click + Escape, mirroring the district popover.
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

  // Mobile bottom-sheet body lock.
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

  const allSelected = selected.size === SCAN_DISTRICT_OPTIONS.length;
  const noneSelected = selected.size === 0;

  const triggerLabel = (() => {
    if (disabled) return label;
    if (allSelected) return label;
    if (noneSelected) return `${label} (בחר מחוז)`;
    return `${label} (${selected.size})`;
  })();

  const handleSubmit = () => {
    if (noneSelected) return;
    setOpen(false);
    // Empty list = "scan everything" → only send the explicit list
    // when it's a strict subset.
    onSubmit(allSelected ? [] : Array.from(selected));
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
              <span className="toolbar-district-title">בחירת מחוזות לסריקה</span>
              <button
                type="button"
                className="toolbar-district-close"
                aria-label="סגור"
                onClick={() => setOpen(false)}
              >
                ✕
              </button>
            </div>

            <div className="toolbar-district-actions">
              <button
                type="button"
                className="toolbar-district-link"
                onClick={() =>
                  setSelected(
                    allSelected
                      ? new Set()
                      : new Set(SCAN_DISTRICT_OPTIONS.map((o) => o.value))
                  )
                }
              >
                {allSelected ? 'נקה הכל' : 'בחר הכל'}
              </button>
            </div>

            <div className="toolbar-district-list" role="listbox" aria-multiselectable="true">
              {SCAN_DISTRICT_OPTIONS.map((option) => {
                const active = selected.has(option.value);
                const style: CSSProperties = solidPillStyle(option.value, active);
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

            <div className="toolbar-district-footer scan-picker-footer">
              <button
                type="button"
                className="toolbar-district-done"
                onClick={handleSubmit}
                disabled={noneSelected}
              >
                {allSelected
                  ? 'הרץ סריקה לכל המחוזות'
                  : `הרץ סריקה (${selected.size})`}
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
