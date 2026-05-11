'use client';

export type DashboardTab = 'ads' | 'trends';

type Props = {
  tab: DashboardTab;
  onChange: (next: DashboardTab) => void;
};

const TABS: { value: DashboardTab; label: string; icon: string }[] = [
  { value: 'ads', label: 'מודעות', icon: '🏠' },
  { value: 'trends', label: 'טרנדים', icon: '📊' }
];

export default function TabBar({ tab, onChange }: Props) {
  return (
    <div className="tab-bar-wrap">
      <div className="tab-bar" role="tablist" aria-label="מצבי תצוגה">
        {TABS.map((entry) => (
          <button
            key={entry.value}
            type="button"
            role="tab"
            aria-selected={tab === entry.value}
            className={`tab-bar-option ${tab === entry.value ? 'is-active' : ''}`}
            onClick={() => onChange(entry.value)}
          >
            <span className="tab-bar-icon" aria-hidden="true">
              {entry.icon}
            </span>
            <span>{entry.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
