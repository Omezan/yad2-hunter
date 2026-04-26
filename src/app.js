const express = require('express');
const { ALL_SEARCHES } = require('./config/searches');
const { query } = require('./db');
const {
  getDashboardSummary,
  getRun,
  listAds,
  listRecentRuns
} = require('./db/repository');
const { renderDashboard, renderErrorPage, renderRunPage } = require('./views/render');

function parseOptionalNumber(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseFilters(query) {
  return {
    districtKey: query.districtKey || '',
    searchId: query.searchId || '',
    q: query.q || '',
    minPrice: parseOptionalNumber(query.minPrice),
    maxPrice: parseOptionalNumber(query.maxPrice),
    minRooms: parseOptionalNumber(query.minRooms),
    maxRooms: parseOptionalNumber(query.maxRooms)
  };
}

function createApp() {
  const app = express();

  app.get('/health', async (req, res, next) => {
    try {
      await query('SELECT 1');
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.get('/', async (req, res, next) => {
    try {
      const filters = parseFilters(req.query);

      const [summary, runs, ads] = await Promise.all([
        getDashboardSummary(),
        listRecentRuns(20),
        listAds(filters, { limit: 100 })
      ]);

      res.send(
        renderDashboard({
          summary,
          runs,
          ads,
          filters,
          searches: ALL_SEARCHES
        })
      );
    } catch (error) {
      next(error);
    }
  });

  app.get('/runs/:id', async (req, res, next) => {
    try {
      const filters = parseFilters(req.query);
      const run = await getRun(req.params.id);

      if (!run) {
        res.status(404).send(renderErrorPage(new Error('הריצה שביקשת לא נמצאה.')));
        return;
      }

      const ads = await listAds(filters, {
        limit: 100,
        runId: run.id
      });

      res.send(
        renderRunPage({
          run,
          ads,
          filters,
          searches: ALL_SEARCHES
        })
      );
    } catch (error) {
      next(error);
    }
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    console.error(error);
    res.status(500).send(renderErrorPage(error));
  });

  return app;
}

module.exports = {
  createApp
};
