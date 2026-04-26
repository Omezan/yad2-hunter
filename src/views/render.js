function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateTime(value) {
  if (!value) {
    return '—';
  }

  return new Intl.DateTimeFormat('he-IL', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(value));
}

function formatPrice(value) {
  if (value === null || value === undefined) {
    return '—';
  }

  return `${new Intl.NumberFormat('he-IL').format(value)} ₪`;
}

function formatRooms(value) {
  if (value === null || value === undefined) {
    return '—';
  }

  return `${value} חדרים`;
}

function renderFilterForm({ action, filters, searches }) {
  const districtOptions = Array.from(
    new Map(
      searches.map((search) => [
        search.districtKey,
        { key: search.districtKey, label: search.districtLabel }
      ])
    ).values()
  );

  return `
    <form class="filters" method="GET" action="${escapeHtml(action)}">
      <label>
        מחוז
        <select name="districtKey">
          <option value="">הכל</option>
          ${districtOptions
            .map(
              (option) => `
                <option value="${escapeHtml(option.key)}" ${
                  filters.districtKey === option.key ? 'selected' : ''
                }>${escapeHtml(option.label)}</option>
              `
            )
            .join('')}
        </select>
      </label>
      <label>
        חיפוש שמור
        <select name="searchId">
          <option value="">הכל</option>
          ${searches
            .map(
              (search) => `
                <option value="${escapeHtml(search.id)}" ${
                  filters.searchId === search.id ? 'selected' : ''
                }>${escapeHtml(search.label)}</option>
              `
            )
            .join('')}
        </select>
      </label>
      <label>
        חיפוש חופשי
        <input type="text" name="q" value="${escapeHtml(filters.q)}" placeholder="עיר, שכונה, טקסט..." />
      </label>
      <label>
        מחיר מינימלי
        <input type="number" name="minPrice" value="${escapeHtml(filters.minPrice ?? '')}" />
      </label>
      <label>
        מחיר מקסימלי
        <input type="number" name="maxPrice" value="${escapeHtml(filters.maxPrice ?? '')}" />
      </label>
      <label>
        חדרים מינימלי
        <input type="number" step="0.5" name="minRooms" value="${escapeHtml(filters.minRooms ?? '')}" />
      </label>
      <label>
        חדרים מקסימלי
        <input type="number" step="0.5" name="maxRooms" value="${escapeHtml(filters.maxRooms ?? '')}" />
      </label>
      <button type="submit">סנן</button>
      <a class="reset-link" href="${escapeHtml(action)}">נקה</a>
    </form>
  `;
}

function renderRunsTable(runs) {
  if (!runs.length) {
    return '<p class="empty-state">עדיין אין היסטוריית ריצות.</p>';
  }

  return `
    <table>
      <thead>
        <tr>
          <th>ריצה</th>
          <th>זמן</th>
          <th>סטטוס</th>
          <th>חדשות</th>
          <th>רלוונטיות</th>
          <th>טלגרם</th>
        </tr>
      </thead>
      <tbody>
        ${runs
          .map(
            (run) => `
              <tr>
                <td><a href="/runs/${run.id}">#${run.id}</a></td>
                <td>${escapeHtml(formatDateTime(run.startedAt))}</td>
                <td>${escapeHtml(run.status)}</td>
                <td>${escapeHtml(run.newAds)}</td>
                <td>${escapeHtml(run.relevantAds)}</td>
                <td>${run.telegramSentAt ? 'נשלח' : 'לא נשלח'}</td>
              </tr>
            `
          )
          .join('')}
      </tbody>
    </table>
  `;
}

function renderAdsTable(ads) {
  if (!ads.length) {
    return '<p class="empty-state">לא נמצאו מודעות התואמות למסננים.</p>';
  }

  return `
    <table>
      <thead>
        <tr>
          <th>כותרת</th>
          <th>מיקום</th>
          <th>מחוז</th>
          <th>מחיר</th>
          <th>חדרים</th>
          <th>נראה לראשונה</th>
        </tr>
      </thead>
      <tbody>
        ${ads
          .map(
            (ad) => `
              <tr>
                <td>
                  <a href="${escapeHtml(ad.link)}" target="_blank" rel="noreferrer">${escapeHtml(
                    ad.title
                  )}</a>
                  <div class="ad-meta">${escapeHtml(ad.searchLabel)}</div>
                </td>
                <td>${escapeHtml(ad.locationText || '—')}</td>
                <td>${escapeHtml(ad.districtLabel)}</td>
                <td>${escapeHtml(formatPrice(ad.price))}</td>
                <td>${escapeHtml(formatRooms(ad.rooms))}</td>
                <td>${escapeHtml(formatDateTime(ad.firstSeenAt))}</td>
              </tr>
            `
          )
          .join('')}
      </tbody>
    </table>
  `;
}

function renderLayout(title, content) {
  return `
    <!doctype html>
    <html lang="he" dir="rtl">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(title)}</title>
        <style>
          body {
            margin: 0;
            font-family: Arial, sans-serif;
            background: #f5f7fb;
            color: #1f2937;
          }
          main {
            max-width: 1120px;
            margin: 0 auto;
            padding: 32px 16px 48px;
          }
          h1, h2 {
            margin-top: 0;
          }
          .topbar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 16px;
            flex-wrap: wrap;
            margin-bottom: 24px;
          }
          .card-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 16px;
            margin-bottom: 24px;
          }
          .card, section {
            background: #fff;
            border-radius: 12px;
            padding: 18px;
            box-shadow: 0 6px 20px rgba(15, 23, 42, 0.08);
          }
          .card strong {
            display: block;
            font-size: 28px;
            margin-top: 8px;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            font-size: 14px;
          }
          th, td {
            padding: 12px 10px;
            text-align: right;
            border-bottom: 1px solid #e5e7eb;
            vertical-align: top;
          }
          th {
            color: #4b5563;
            font-weight: 700;
          }
          a {
            color: #2563eb;
            text-decoration: none;
          }
          a:hover {
            text-decoration: underline;
          }
          .filters {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
            gap: 12px;
            align-items: end;
            margin-bottom: 20px;
          }
          .filters label {
            display: flex;
            flex-direction: column;
            gap: 6px;
            font-size: 14px;
          }
          .filters input,
          .filters select,
          .filters button {
            border: 1px solid #cbd5e1;
            border-radius: 10px;
            padding: 10px 12px;
            font: inherit;
          }
          .filters button {
            background: #2563eb;
            color: #fff;
            cursor: pointer;
          }
          .filters .reset-link {
            align-self: center;
            justify-self: start;
          }
          .section-stack {
            display: grid;
            gap: 20px;
          }
          .muted {
            color: #6b7280;
            font-size: 14px;
          }
          .ad-meta {
            margin-top: 6px;
            color: #6b7280;
            font-size: 12px;
          }
          .empty-state {
            color: #6b7280;
          }
        </style>
      </head>
      <body>
        <main>${content}</main>
      </body>
    </html>
  `;
}

function renderDashboard({ summary, runs, ads, filters, searches }) {
  return renderLayout(
    'Yad2 Hunter Dashboard',
    `
      <div class="topbar">
        <div>
          <h1>Yad2 Hunter</h1>
          <p class="muted">היסטוריית סריקות, מודעות חדשות ומסננים בסיסיים.</p>
        </div>
        <a href="/health">Health</a>
      </div>

      <div class="card-grid">
        <div class="card"><span>סה״כ מודעות שמורות</span><strong>${escapeHtml(summary.totalAds)}</strong></div>
        <div class="card"><span>סה״כ ריצות</span><strong>${escapeHtml(summary.totalRuns)}</strong></div>
        <div class="card"><span>ריצות עם עדכון</span><strong>${escapeHtml(summary.runsWithUpdates)}</strong></div>
        <div class="card"><span>סה״כ מודעות חדשות</span><strong>${escapeHtml(summary.totalNewAds)}</strong></div>
      </div>

      <div class="section-stack">
        <section>
          <h2>פילטרים</h2>
          ${renderFilterForm({ action: '/', filters, searches })}
          ${renderAdsTable(ads)}
        </section>

        <section>
          <h2>העדכונים האחרונים</h2>
          ${renderRunsTable(runs)}
        </section>
      </div>
    `
  );
}

function renderRunPage({ run, ads, filters, searches }) {
  return renderLayout(
    `Run #${run.id}`,
    `
      <div class="topbar">
        <div>
          <h1>עדכון #${escapeHtml(run.id)}</h1>
          <p class="muted">
            התחיל ב-${escapeHtml(formatDateTime(run.startedAt))}
            | סטטוס: ${escapeHtml(run.status)}
            | מודעות חדשות: ${escapeHtml(run.newAds)}
          </p>
        </div>
        <a href="/">חזרה לדשבורד</a>
      </div>

      <section>
        <h2>מודעות חדשות בריצה הזו</h2>
        ${renderFilterForm({ action: `/runs/${run.id}`, filters, searches })}
        ${renderAdsTable(ads)}
      </section>
    `
  );
}

function renderErrorPage(error) {
  return renderLayout(
    'Server error',
    `
      <section>
        <h1>שגיאת שרת</h1>
        <p class="muted">${escapeHtml(error.message)}</p>
      </section>
    `
  );
}

module.exports = {
  renderDashboard,
  renderErrorPage,
  renderRunPage
};
