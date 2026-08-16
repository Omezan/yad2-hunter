import puppeteer from "@cloudflare/puppeteer";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

async function configurePage(page) {
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({
    "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
  });
  await page.setViewport({ width: 1440, height: 900 });
}

function isCaptchaPage(title, bodyText) {
  const t = (title || "").toLowerCase();
  const b = (bodyText || "").toLowerCase();
  if (t.includes("captcha") || t.includes("shieldsquare")) return true;
  if (t.includes("are you for real")) return true;
  if (/radware|bot.manager.block|shieldsquare/i.test(b)) return true;
  if (/verifying your browser/i.test(b) && b.length < 500) return true;
  return false;
}

async function checkCaptcha(page) {
  return page.evaluate(() => {
    const title = document.title || "";
    const body = document.body?.innerText || "";
    return { title, body, isCaptcha: false };
  }).then(({ title, body }) => isCaptchaPage(title, body));
}

async function waitForChallenge(page, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const blocked = await checkCaptcha(page);
    if (!blocked) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function warmUp(page) {
  await page.goto("https://www.yad2.co.il/", {
    waitUntil: "networkidle2",
    timeout: 20000,
  });
  const needsChallenge = await checkCaptcha(page);
  if (needsChallenge) {
    await waitForChallenge(page, 12000);
  }
  await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1000));
}

async function handleSearch(env, targetUrl) {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await configurePage(page);

    await warmUp(page);

    await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 30000 });

    if (await checkCaptcha(page)) {
      const passed = await waitForChallenge(page, 15000);
      if (!passed) {
        return Response.json({ ok: false, error: "captcha", anchors: [] });
      }
    }

    const hasItems = await page
      .waitForSelector('a[href*="/realestate/item/"]', { timeout: 12000 })
      .then(() => true)
      .catch(() => false);

    if (!hasItems) {
      const snippet = await page.evaluate(
        () => (document.body?.innerText || "").slice(0, 300)
      );
      return Response.json({
        ok: false,
        error: "no_items",
        snippet,
        anchors: [],
      });
    }

    await page.evaluate(async () => {
      for (let i = 0; i < 8; i++) {
        window.scrollBy(0, Math.max(window.innerHeight, 600));
        await new Promise((r) => setTimeout(r, 300));
      }
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((r) => setTimeout(r, 800));
    });

    const result = await page.evaluate(() => {
      let expectedCount = null;
      const headings = document.querySelectorAll(
        'h1, h2, [class*="results"], [data-testid*="results"]'
      );
      for (const el of headings) {
        const m = (el.innerText || "").match(/(\d{1,4})\s*תוצאות?/);
        if (m) {
          expectedCount = parseInt(m[1], 10);
          break;
        }
      }

      const anchors = [];
      const seen = new Set();
      document.querySelectorAll('a[href*="/realestate/item/"]').forEach((a) => {
        const href = a.href || "";
        if (!href || seen.has(href)) return;
        seen.add(href);

        const container =
          a.closest("article") ||
          a.closest("li") ||
          a.closest('[class*="feed-item"]') ||
          a.closest('[class*="feed_item"]') ||
          a.closest('[class*="card"]');

        anchors.push({
          href,
          text: (a.innerText || "").trim(),
          containerText: (container?.innerText || a.innerText || "").trim(),
        });
      });

      return { expectedCount, anchors };
    });

    return Response.json({ ok: true, ...result });
  } finally {
    await browser.close();
  }
}

async function handleDetail(env, targetUrl) {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await configurePage(page);

    await warmUp(page);

    await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 30000 });

    if (await checkCaptcha(page)) {
      await waitForChallenge(page, 15000);
    }

    const nextData = await page.evaluate(() => {
      const el = document.getElementById("__NEXT_DATA__");
      if (!el) return null;
      try {
        return JSON.parse(el.textContent || "");
      } catch {
        return null;
      }
    });

    const stillBlocked = await checkCaptcha(page);
    if (stillBlocked && !nextData) {
      return Response.json({ ok: false, error: "captcha" });
    }

    const data = await page.evaluate(() => {
      function textOf(sel) {
        const el = document.querySelector(sel);
        return el ? (el.innerText || "").trim() : "";
      }

      function findDesc() {
        const sels = [
          '[data-testid*="description"]',
          '[class*="description"]',
          '[itemprop="description"]',
        ];
        const blocks = new Set();
        for (const sel of sels) {
          document.querySelectorAll(sel).forEach((el) => {
            const t = (el.innerText || "").trim();
            if (t.length >= 20 && t.length <= 4000) blocks.add(t);
          });
        }
        return Array.from(blocks).join("\n").trim();
      }

      function findAddr() {
        for (const sel of [
          '[data-testid*="address"]',
          '[class*="address"]',
          '[class*="location"]',
          '[itemprop="address"]',
        ]) {
          const el = document.querySelector(sel);
          if (el) {
            const t = (el.innerText || "").trim();
            if (t) return t;
          }
        }
        return "";
      }

      return {
        titleHeading: textOf("h1"),
        secondaryHeading: textOf("h2"),
        subTitle:
          textOf('[class*="property-type"]') ||
          textOf('[data-testid*="property-type"]'),
        addressText: findAddr(),
        descriptionText: findDesc(),
        allText: (document.body?.innerText || "").trim(),
      };
    });

    return Response.json({ ok: true, nextData, ...data });
  } finally {
    await browser.close();
  }
}

export default {
  async fetch(request, env) {
    const token = request.headers.get("x-auth-token");
    if (token !== env.AUTH_TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }

    const url = new URL(request.url);
    const targetUrl = url.searchParams.get("url");
    if (!targetUrl) {
      return new Response("Missing ?url= parameter", { status: 400 });
    }

    const mode = url.searchParams.get("mode") || "search";

    try {
      if (mode === "detail") {
        return await handleDetail(env, targetUrl);
      }
      return await handleSearch(env, targetUrl);
    } catch (err) {
      return Response.json({ ok: false, error: err.message }, { status: 500 });
    }
  },
};
