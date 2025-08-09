// Lightweight site-scoped crawler and indexer (per-scope storage)
// Scope: host + top-level directory from a starting URL, e.g. https://site/courses/ → only URLs under /courses/

const MAX_PAGES_PER_CRAWL = 60; // pages per individual crawl session
const MAX_CONCURRENT = 4;
const FETCH_TIMEOUT_MS = 12000;
const MAX_TEXT_LEN = 20000; // per page slice to keep memory small

/**
 * pageIndex maps scopeKey → Map<url, {title, text, url, ts}>
 * scopeKey format: `${host}|/${topSegment}/` (or `${host}|/` when no segment)
 */
const pageIndex = new Map();
let currentCrawl = null; // { scopeKey: string, promise: Promise }

function scopeFromUrl(raw) {
  try {
    const u = new URL(raw);
    const parts = (u.pathname || '/').split('/').filter(Boolean);
    const scopePath = parts.length ? `/${parts[0]}/` : '/';
    return { origin: u.origin, host: u.host, scopePath };
  } catch {
    return null;
  }
}

function makeScopeKey(url) {
  const s = scopeFromUrl(url);
  if (!s) return null;
  return `${s.host}|${s.scopePath}`;
}

function inScope(url, scope) {
  try {
    const u = new URL(url, `${scope.origin}/`);
    return u.host === scope.host && u.pathname.startsWith(scope.scopePath);
  } catch {
    return false;
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}

// Regex-based extractor that works in a worker context
function extractLinksAndText(html, baseUrl) {
  // Title
  let title = '';
  const mTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (mTitle) title = (mTitle[1] || '').replace(/\s+/g, ' ').trim();

  // Remove scripts/styles to reduce noise
  let body = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
                 .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
                 .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, ' ');

  // Links
  const links = [];
  const reHref = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = reHref.exec(body)) !== null) {
    const href = m[1];
    try {
      const u = new URL(href, baseUrl);
      links.push(u.toString());
    } catch (_) {}
  }

  // Text content: strip tags
  const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_LEN);

  return { title, links, text };
}

async function fetchPage(url) {
  try {
    console.log('[crawler] Fetch:', url);
    const res = await withTimeout(fetch(url, { credentials: 'include', redirect: 'follow' }), FETCH_TIMEOUT_MS);
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    // Accept common HTML mime types; some servers omit it, accept if body seems HTML
    if (!res.ok) {
      console.log('[crawler] Skip (bad status):', url, res.status);
      return null;
    }
    const html = await res.text();
    if (!(ctype.includes('text/html') || ctype.includes('application/xhtml') || /<html[\s>]/i.test(html))) {
      console.log('[crawler] Skip (non-HTML):', url, ctype);
      return null;
    }
    return extractLinksAndText(html, url);
  } catch (err) {
    console.log('[crawler] Error fetching:', url, String(err));
    return null;
  }
}

async function crawl(startUrl) {
  const scope = scopeFromUrl(startUrl);
  if (!scope) return { pages: 0 };
  const scopeKey = makeScopeKey(startUrl);

  console.log('[crawler] Start:', startUrl, '→ scope', scopeKey);

  if (!pageIndex.has(scopeKey)) pageIndex.set(scopeKey, new Map());
  const index = pageIndex.get(scopeKey);

  const queue = [startUrl];
  const visited = new Set(); // start fresh for each crawl session
  let active = 0;
  let pagesThisSession = 0;

  return new Promise((resolve) => {
    function maybeDone() {
      if ((queue.length === 0 && active === 0) || pagesThisSession >= MAX_PAGES_PER_CRAWL) {
        console.log('[crawler] Done. Indexed pages this session:', pagesThisSession, 'total in scope:', index.size, 'scope', scopeKey);
        resolve({ pages: index.size, scopeKey });
      }
    }

    async function worker() {
      while (queue.length && pagesThisSession < MAX_PAGES_PER_CRAWL) {
        const url = queue.shift();
        if (!url || visited.has(url) || index.has(url)) continue; // skip if already indexed
        visited.add(url);
        active++;
        const page = await fetchPage(url);
        if (page) {
          index.set(url, { title: page.title, text: page.text, url, ts: Date.now() });
          pagesThisSession++;
          console.log('[crawler] Indexed:', url, '| title:', page.title || '(no title)', '| links:', page.links.length, '| text chars:', page.text.length, '| session:', pagesThisSession);
          let enq = 0;
          for (const link of page.links) {
            if (inScope(link, scope) && !visited.has(link) && !index.has(link)) {
              queue.push(link);
              enq++;
            }
          }
          if (enq) console.log('[crawler] Enqueued', enq, 'links from', url);
        }
        active--;
      }
      maybeDone();
    }

    for (let i = 0; i < Math.min(MAX_CONCURRENT, 6); i++) worker();
  });
}

function score(query, text, title) {
  const q = query.toLowerCase();
  if (!q) return 0;
  let s = 0;
  const t = (title || '').toLowerCase();
  const body = (text || '').toLowerCase();
  if (t.startsWith(q)) s += 30;
  if (t.includes(q)) s += 20;
  const idx = body.indexOf(q);
  if (idx >= 0) s += 10 + Math.max(0, 20 - idx / 50);
  return s;
}

function buildTextFragment(text, query) {
  if (!text || !query) return '';
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return '';
  const frag = text.slice(Math.max(0, i - 20), Math.min(text.length, i + 80)).replace(/\s+/g, ' ').trim();
  const encoded = encodeURIComponent(frag);
  return `#:~:text=${encoded}`;
}

// Reset crawler when navigating to a new page
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    console.log('[crawler] Tab updated:', tab.url);
    const newScopeKey = makeScopeKey(tab.url);
    
    // Clear current crawl if it's for a different scope
    if (currentCrawl && currentCrawl.scopeKey !== newScopeKey) {
      console.log('[crawler] Resetting crawl for new scope:', newScopeKey);
      currentCrawl = null;
    }
    
    // Auto-start crawling for the new page
    if (newScopeKey && (!currentCrawl || currentCrawl.scopeKey !== newScopeKey)) {
      console.log('[crawler] Auto-starting crawl for:', tab.url);
      crawl(tab.url).then((res) => {
        if (currentCrawl && currentCrawl.scopeKey === newScopeKey) {
          currentCrawl = null;
        }
        return res;
      });
      currentCrawl = { scopeKey: newScopeKey, promise: crawl(tab.url) };
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'CRAWL_START') {
    const { startUrl } = msg;
    const scopeKey = makeScopeKey(startUrl);
    if (currentCrawl && currentCrawl.scopeKey === scopeKey) {
      console.log('[crawler] Already running for scope', scopeKey);
      sendResponse({ ok: true, running: true, scopeKey });
      return true;
    }
    const promise = crawl(startUrl).then((res) => {
      if (currentCrawl && currentCrawl.scopeKey === scopeKey) currentCrawl = null;
      return res;
    });
    currentCrawl = { scopeKey, promise };
    console.log('[crawler] Start requested for', startUrl, 'scope', scopeKey);
    sendResponse({ ok: true, started: true, scopeKey });
    return true;
  }

  if (msg.type === 'CRAWL_STATUS') {
    const { scopeKey } = msg;
    const idx = pageIndex.get(scopeKey);
    const running = !!(currentCrawl && currentCrawl.scopeKey === scopeKey);
    const status = { pages: idx ? idx.size : 0, running, scopeKey };
    console.log('[crawler] Status:', status);
    sendResponse(status);
    return true;
  }

  if (msg.type === 'CRAWL_SEARCH') {
    const { query, scopeKey } = msg;
    console.log('[crawler] Search request:', query, 'scope', scopeKey);
    const idx = pageIndex.get(scopeKey);
    const items = [];
    if (idx) {
      for (const [url, page] of idx.entries()) {
        const s = score(query, page.text, page.title);
        if (s > 0) items.push({ url, title: page.title || url, score: s, text: page.text });
      }
    }
    items.sort((a, b) => b.score - a.score);
    const top = items.slice(0, 20).map((it) => ({
      id: `crawl:${it.url}`,
      level: 'site',
      title: `${it.title} — ${it.url}`,
      url: it.url,
      fragment: buildTextFragment(it.text, query),
    }));
    sendResponse({ results: top, scopeKey });
    return true;
  }
}); 