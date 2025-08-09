const DEBOUNCE_MS = 150;
const MAX_RESULTS = 20;

const searchInput = document.getElementById('searchInput');
const suggestList = document.getElementById('suggestList');
const emptyState = document.getElementById('emptyState');
const crawlStatusEl = document.getElementById('crawlStatus');
const crawlStatusText = document.getElementById('crawlStatusText');
const scopeToggle = document.getElementById('scopeToggle');
const scopeLabel = document.getElementById('scopeLabel');

let activeIndex = -1;
let currentSuggestions = [];
let activeTabId = null;
let activeTabUrl = null;
let lastQuery = '';
let crawlPollTimer = null;
let isSiteMode = false;
let scopeKey = null;

function computeScopeKey(url) {
  try {
    const u = new URL(url);
    const parts = (u.pathname || '/').split('/').filter(Boolean);
    const scopePath = parts.length ? `/${parts[0]}/` : '/';
    return `${u.host}|${scopePath}`;
  } catch {
    return null;
  }
}

function setScopeUI() {
  isSiteMode = !!scopeToggle.checked;
  scopeLabel.textContent = 'Search all pages';
  searchInput.placeholder = isSiteMode ? 'Search all pages…' : 'Search this page…';
  crawlStatusEl.classList.toggle('hidden', !isSiteMode);
}

scopeToggle?.addEventListener('change', async () => {
  setScopeUI();
  // re-run search with same query in new scope
  const q = searchInput.value.trim();
  if (q.length || isSiteMode) {
    await runSearch(q);
  } else {
    // page mode with empty query → show local headings
    await runSearch('');
  }
});

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Parse an optional @domain or @url token from the query. Returns { cleanedQuery, overrideHost }
function parseDomainOverride(rawQuery) {
  const tokens = (rawQuery || '').split(/\s+/).filter(Boolean);
  let overrideHost = null;
  const kept = [];
  for (const tok of tokens) {
    if (tok.startsWith('@') && tok.length > 1) {
      const rest = tok.slice(1);
      try {
        const u = new URL(rest.includes('://') ? rest : `https://${rest}`);
        if (u.host) overrideHost = u.host;
      } catch (_) {
        const stripped = rest.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
        if (stripped) overrideHost = stripped;
      }
    } else {
      kept.push(tok);
    }
  }
  return { cleanedQuery: kept.join(' ').trim(), overrideHost };
}

async function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (tab) {
        activeTabId = tab.id;
        activeTabUrl = tab.url || null;
        scopeKey = activeTabUrl ? computeScopeKey(activeTabUrl) : null;
      }
      resolve(tab || null);
    });
  });
}

async function getActiveTabId() {
  if (activeTabId !== null) return activeTabId;
  const tab = await getActiveTab();
  return tab ? tab.id : null;
}

async function getAllFrames(tabId) {
  return new Promise((resolve) => {
    chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
      if (chrome.runtime.lastError || !Array.isArray(frames)) {
        resolve([]);
        return;
      }
      resolve(frames);
    });
  });
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildHighlightedHtml(text, query) {
  if (!text) return '';
  if (!query || !query.trim()) return escapeHtml(text);
  const tokens = Array.from(new Set(query.trim().split(/\s+/g).filter(Boolean)));
  if (!tokens.length) return escapeHtml(text);

  const lowerText = text.toLowerCase();
  const ranges = [];
  for (const t of tokens) {
    const tLower = t.toLowerCase();
    let start = 0;
    while (true) {
      const idx = lowerText.indexOf(tLower, start);
      if (idx === -1) break;
      ranges.push({ start: idx, end: idx + tLower.length });
      start = idx + tLower.length;
    }
  }
  if (!ranges.length) return escapeHtml(text);
  ranges.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const r of ranges) {
    if (!merged.length || r.start > merged[merged.length - 1].end) {
      merged.push({ ...r });
    } else {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, r.end);
    }
  }

  let html = '';
  let cursor = 0;
  for (const r of merged) {
    if (cursor < r.start) {
      html += escapeHtml(text.slice(cursor, r.start));
    }
    const segment = text.slice(r.start, r.end);
    html += `<mark class=\"suggest-hl\">${escapeHtml(segment)}</mark>`;
    cursor = r.end;
  }
  if (cursor < text.length) {
    html += escapeHtml(text.slice(cursor));
  }
  return html;
}

async function requestLocalSuggestions(query) {
  const tabId = await getActiveTabId();
  if (!tabId) return [];
  const frames = await getAllFrames(tabId);
  if (!frames.length) return [];

  const perFramePromises = frames.map((frame) => {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(
        tabId,
        { type: 'PAGE_JUMP_GET_SUGGESTIONS', query, limit: MAX_RESULTS },
        { frameId: frame.frameId },
        (response) => {
          if (chrome.runtime.lastError || !response || !Array.isArray(response.suggestions)) {
            resolve([]);
            return;
          }
          resolve(response.suggestions.map((s) => ({ ...s, _frameId: frame.frameId, _frameUrl: frame.url })));
        }
      );
    });
  });

  const results = await Promise.allSettled(perFramePromises);
  const all = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) all.push(...r.value);
  }
  const seen = new Set();
  const deduped = [];
  for (const item of all) {
    if (item && !seen.has(item.id)) {
      seen.add(item.id);
      deduped.push(item);
    }
    if (deduped.length >= MAX_RESULTS) break;
  }
  return deduped;
}

async function ensureCrawlStarted() {
  const tab = await getActiveTab();
  if (!tab || !activeTabUrl || !scopeKey) return;
  chrome.runtime.sendMessage({ type: 'CRAWL_START', startUrl: activeTabUrl, scopeKey }, () => {});
}

async function requestCrawlSuggestions(query) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'CRAWL_SEARCH', query, scopeKey }, (resp) => {
      if (chrome.runtime.lastError || !resp || !Array.isArray(resp.results)) {
        resolve([]);
        return;
      }
      resolve(resp.results);
    });
  });
}

async function requestCrawlStatus() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'CRAWL_STATUS', scopeKey }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        resolve({ pages: 0, running: false });
        return;
      }
      resolve(resp);
    });
  });
}

function renderCrawlStatus(status) {
  if (!isSiteMode) { crawlStatusEl.classList.add('hidden'); return; }
  if (!status) { crawlStatusEl.classList.add('hidden'); return; }
  const { running, pages } = status;
  if (running) {
    crawlStatusEl.classList.remove('hidden', 'done');
    crawlStatusText.textContent = `Crawling… ${pages} page${pages === 1 ? '' : 's'} indexed`;
  } else if (pages > 0) {
    crawlStatusEl.classList.remove('hidden');
    crawlStatusEl.classList.add('done');
    crawlStatusText.textContent = `Indexed ${pages} page${pages === 1 ? '' : 's'}`;
  } else {
    crawlStatusEl.classList.add('hidden');
  }
}

function scheduleCrawlRefresh(query) {
  if (!isSiteMode) return; // no crawl polling in page mode
  clearTimeout(crawlPollTimer);
  crawlPollTimer = setTimeout(async () => {
    const status = await requestCrawlStatus();
    if (query !== lastQuery) return; // user changed query
    renderCrawlStatus(status);
    if (!status.running && status.pages === 0) return; // nothing to show
    const crawl = await requestCrawlSuggestions(query);
    if (query !== lastQuery) return;
    if (crawl && crawl.length) {
      const localItems = currentSuggestions.filter((x) => !x.url);
      renderSuggestions([...localItems, ...crawl], query);
    }
    if (status.running) {
      scheduleCrawlRefresh(query);
    }
  }, 1200);
}

async function goToSuggestion(index) {
  const tabId = await getActiveTabId();
  if (!tabId) return;
  const item = currentSuggestions[index];
  if (!item) return;

  if (item.url) {
    chrome.tabs.create({ url: item.url + (item.fragment || '') });
    window.close();
    return;
  }

  const frames = await getAllFrames(tabId);
  const target = frames.find((f) => f.url === item.frameHref || f.frameId === item._frameId);
  if (target) {
    chrome.tabs.sendMessage(tabId, { type: 'PAGE_JUMP_SCROLL_TO', id: item.id }, { frameId: target.frameId });
  } else {
    chrome.tabs.sendMessage(tabId, { type: 'PAGE_JUMP_SCROLL_TO', id: item.id });
  }
  window.close();
}

function renderSuggestions(items, query) {
  currentSuggestions = items;
  suggestList.innerHTML = '';
  activeIndex = items.length ? 0 : -1;
  emptyState.classList.toggle('hidden', items.length !== 0);

  items.forEach((item, idx) => {
    const li = document.createElement('li');
    li.className = 'suggestion' + (idx === activeIndex ? ' active' : '');
    li.setAttribute('role', 'option');
    li.dataset.index = String(idx);

    const level = document.createElement('span');
    level.className = 'level';
    level.textContent = item.level || '';

    const title = document.createElement('span');
    title.className = 'title';
    title.innerHTML = buildHighlightedHtml(item.title || '', query || '');

    li.appendChild(level);
    li.appendChild(title);

    li.addEventListener('click', () => goToSuggestion(idx));

    suggestList.appendChild(li);
  });
}

async function runSearch(raw) {
  const { cleanedQuery } = parseDomainOverride(raw);
  lastQuery = cleanedQuery;
  await getActiveTab();
  if (isSiteMode) {
    await ensureCrawlStarted();
    const [local, crawl, status] = await Promise.all([
      requestLocalSuggestions(cleanedQuery),
      requestCrawlSuggestions(cleanedQuery),
      requestCrawlStatus(),
    ]);
    renderSuggestions([...local, ...crawl], cleanedQuery);
    renderCrawlStatus(status);
    if (!crawl.length || status.running) scheduleCrawlRefresh(cleanedQuery);
  } else {
    const local = await requestLocalSuggestions(cleanedQuery);
    renderSuggestions(local, cleanedQuery);
    renderCrawlStatus(null);
  }
}

const onInput = debounce(async () => {
  await runSearch(searchInput.value.trim());
}, DEBOUNCE_MS);

searchInput.addEventListener('input', onInput);

searchInput.addEventListener('keydown', (e) => {
  const items = suggestList.querySelectorAll('.suggestion');
  if (!items.length) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeIndex = (activeIndex + 1) % items.length;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIndex = (activeIndex - 1 + items.length) % items.length;
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (activeIndex >= 0) {
      goToSuggestion(activeIndex);
    }
    return;
  } else {
    return; // input handler will update on next tick
  }

  items.forEach((el, idx) => {
    if (idx === activeIndex) el.classList.add('active');
    else el.classList.remove('active');
  });
});

(async function init() {
  setScopeUI();
  await getActiveTab();
  if (isSiteMode) await ensureCrawlStarted();
  await runSearch('');
  searchInput.focus();
})(); 