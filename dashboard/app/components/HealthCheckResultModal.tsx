'use client';

import ResultModal from './ResultModal';
import { formatHebrewDateTime } from '../lib/freshness';

type Props = {
  open: boolean;
  onClose: () => void;
  dispatchedAt: string | null;
  completedAt: string | null;
};

export default function HealthCheckResultModal({
  open,
  onClose,
  dispatchedAt,
  completedAt
}: Props) {
  const subtitle = (() => {
    const parts: string[] = [];
    if (dispatchedAt) {
      const dispatched = formatHebrewDateTime(dispatchedAt);
      if (dispatched) parts.push(`הופעל: ${dispatched}`);
    }
    if (completedAt) {
      const completed = formatHebrewDateTime(completedAt);
      if (completed) parts.push(`הסתיים: ${completed}`);
    }
    return parts.length ? parts.join(' · ') : null;
  })();

  return (
    <ResultModal
      open={open}
      onClose={onClose}
      title="בדיקת התקינות הסתיימה"
      subtitle={subtitle}
      ariaLabelledBy="health-check-result-title"
      footer={
        <div className="modal-actions">
          <button type="button" className="primary" onClick={onClose}>
            סגור
          </button>
        </div>
      }
    >
      <p className="modal-text">
        הבדיקה רצה בהצלחה. דוח Real vs Expected לכל מחוז (כולל פערים, אם קיימים) נשלח אליך
        ב-Telegram.
      </p>
      <p className="modal-text-muted">
        אם זוהו פערים, ההודעה כוללת קישור ישיר לכל המודעות שלא נמצאו במאגר.
      </p>
    </ResultModal>
  );
}
