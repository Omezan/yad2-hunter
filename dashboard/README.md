# Yad2 Hunter Dashboard

Private Next.js dashboard that lists every "seen" Yad2 ad and highlights the ones that are new since your last visit. Designed to be deployed on Vercel and to read `seen-ads.json` + `runs.json` from this repo's `state` branch via the GitHub Contents API.

## How it fits in

- The scan worker (`npm run scan` in the repo root) writes `seen-ads.json` and `runs.json` to the `state` branch every 15 minutes via GitHub Actions.
- When new ads are found, the Telegram digest still includes a per-ad list as before, plus a footer link of the form `<DASHBOARD_URL>?since=<runStartedAt-iso>`.
- This dashboard fetches the JSON files from `state`, then renders all ads with filters. Anything with `firstSeenAt > effectiveSince` is flagged "חדש".

## Deploying to Vercel

1. Create a new Vercel project from the same GitHub repository.
2. In **Project Settings → General → Root Directory**, set the root to `dashboard/`.
3. Build & runtime defaults are fine (Next.js, Node 20+).
4. Add the environment variables below in **Settings → Environment Variables** (Production + Preview).
5. Trigger a deployment. Note the URL Vercel assigns (e.g. `https://yad2-hunter.vercel.app`).
6. Set that URL as `DASHBOARD_URL` in the GitHub Actions secrets so the scan workflow can include it in Telegram messages. Then update `.github/workflows/scan.yml` to expose it to the worker (`DASHBOARD_URL: ${{ secrets.DASHBOARD_URL }}`).

## Required environment variables

| Variable              | Where     | Purpose                                                                |
| --------------------- | --------- | ---------------------------------------------------------------------- |
| `DASHBOARD_USERNAME`  | Vercel    | HTTP Basic Auth username.                                              |
| `DASHBOARD_PASSWORD`  | Vercel    | HTTP Basic Auth password.                                              |
| `GITHUB_REPO`         | Vercel    | `<owner>/yad2-hunter`. Used by `/api/state` to call GitHub.            |
| `GITHUB_TOKEN`        | Vercel    | Fine-grained PAT with read access to this repo's `state` branch only. |
| `STATE_BRANCH`        | Vercel    | Defaults to `state` if unset.                                          |
| `DASHBOARD_URL`       | GitHub    | Action secret. Used by the scan worker to append the dashboard link.  |

Set the GitHub PAT to **fine-grained**, scope it to this repository, and grant only `Contents: Read`. Do **not** commit secrets to git.

## Local development

```bash
cd dashboard
npm install
DASHBOARD_USERNAME=admin \
DASHBOARD_PASSWORD=test \
GITHUB_REPO=<owner>/yad2-hunter \
GITHUB_TOKEN=<your-pat> \
npm run dev
```

Open http://localhost:3000, log in with `admin`/`test`, and confirm ads load. Test the deep link by appending `?since=2026-04-26T12:00:00Z` to the URL; only ads with `firstSeenAt` after that ISO time will be flagged "חדש".

## Architecture notes

- `app/page.tsx` — client component, single-page UI, all filtering done in-browser on the JSON returned by `/api/state`.
- `app/api/state/route.ts` — Node serverless route. Calls `https://api.github.com/repos/<repo>/contents/<file>?ref=<branch>` with `Accept: application/vnd.github.raw` and the PAT, then normalizes the payload into `{ ads, lastRun, generatedAt }`.
- `middleware.ts` — basic auth gate. Runs on every route (page + API), so the JSON proxy is also protected.
- `app/lib/freshness.ts` — helpers for `?since=` parsing, `localStorage.lastVisitAt`, and "is this ad fresh".

## Troubleshooting

- **401 in a loop** — clear browser basic-auth credentials (open in incognito). Confirm Vercel env vars are set in the right environment.
- **`/api/state` returns 500 with "Missing GITHUB_REPO or GITHUB_TOKEN"** — env vars not set on Vercel.
- **`/api/state` returns 500 with "GitHub API … 404"** — `seen-ads.json` doesn't exist on the `state` branch yet. Run a scan first.
- **No "חדש" badges after clicking a Telegram link** — make sure the worker has `DASHBOARD_URL` set; otherwise the footer is silently skipped and the link won't include `?since=`.
