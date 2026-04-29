'use client';

import AdCard from './AdCard';
import ResultModal from './ResultModal';
import type { AdRow } from '../lib/types';
import { formatHebrewDateTime } from '../lib/freshness';

type Props = {
  open: boolean;
  onClose: () => void;
  newAds: AdRow[];
  dispatchedAt: string | null;
  completedAt: string | null;
  onShowInDashboard: () => void;
};

export default function ScanResultModal({
  open,
  onClose,
  newAds,
  dispatchedAt,
  completedAt,
  onShowInDashboard
}: Props) {
  const count = newAds.length;
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

  const title =
    count > 0 ? `נמצאו ${count} מודעות חדשות` : 'הסריקה הידנית הסתיימה';

  return (
    <ResultModal
      open={open}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      ariaLabelledBy="scan-result-title"
      footer={
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            סגור
          </button>
          {count > 0 ? (
            <button
              type="button"
              className="primary"
              onClick={() => {
                onShowInDashboard();
                onClose();
              }}
            >
              פתח בדאשבורד
            </button>
          ) : null}
        </div>
      }
    >
      {count === 0 ? (
        <>
          <p className="modal-text">לא נמצאו מודעות חדשות מאז ההפעלה.</p>
          <p className="modal-text-muted">
            שלחנו עדכון גם ל-Telegram כדי לאשר שהסריקה הסתיימה בהצלחה.
          </p>
        </>
      ) : (
        <div className="modal-grid">
          {newAds.map((ad) => (
            <AdCard key={ad.externalId} ad={ad} isNew />
          ))}
        </div>
      )}
    </ResultModal>
  );
}
