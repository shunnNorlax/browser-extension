const DEBOUNCE_MS = 150;
const MAX_RESULTS = 20;

const searchInput = document.getElementById('searchInput');
const suggestList = document.getElementById('suggestList');
const emptyState = document.getElementById('emptyState');

let activeIndex = -1;
let currentSuggestions = [];
let activeTabId = null;
let lastQuery = '';

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

async function getActiveTabId() {
  if (activeTabId !== null) return activeTabId;
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      activeTabId = tab ? tab.id : null;
      resolve(activeTabId);
    });
  });
}

async function requestSuggestions(query) {
  const tabId = await getActiveTabId();
  if (!tabId) return [];
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId,
      { type: 'PAGE_JUMP_GET_SUGGESTIONS', query, limit: MAX_RESULTS },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve([]);
          return;
        }
        resolve((response && response.suggestions) || []);
      }
    );
  });
}

async function goToSuggestion(index) {
  const tabId = await getActiveTabId();
  if (!tabId) return;
  const item = currentSuggestions[index];
  if (!item) return;
  chrome.tabs.sendMessage(tabId, { type: 'PAGE_JUMP_SCROLL_TO', id: item.id });
  window.close();
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
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
  // merge overlaps
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
    html += `<mark class="suggest-hl">${escapeHtml(segment)}</mark>`;
    cursor = r.end;
  }
  if (cursor < text.length) {
    html += escapeHtml(text.slice(cursor));
  }
  return html;
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

const onInput = debounce(async () => {
  const q = searchInput.value.trim();
  lastQuery = q;
  const suggestions = await requestSuggestions(q);
  renderSuggestions(suggestions, q);
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
    return; // don't re-render for other keys here; input handler will fire
  }

  items.forEach((el, idx) => {
    if (idx === activeIndex) el.classList.add('active');
    else el.classList.remove('active');
  });
});

// Initialize with all headings/paragraphs
(async function init() {
  lastQuery = '';
  const suggestions = await requestSuggestions('');
  renderSuggestions(suggestions, '');
  searchInput.focus();
})(); 