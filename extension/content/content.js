(() => {
  const MARK_ATTR = 'data-ext-jump-id';
  const HIGHLIGHT_CLASS = 'ext-jump-highlight';

  let isIndexed = false;
  let index = [];
  let counter = 0;

  function generateId() {
    counter += 1;
    return `ext-jump-${counter}`;
  }

  function normalizeText(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function truncateForDisplay(text, max = 120) {
    if (!text) return '';
    if (text.length <= max) return text;
    return text.slice(0, max - 1) + '…';
  }

  function ensureElementId(el) {
    if (!el.hasAttribute(MARK_ATTR)) {
      el.setAttribute(MARK_ATTR, generateId());
    }
    return el.getAttribute(MARK_ATTR);
  }

  function isHeadingElement(node) {
    if (!node || !node.tagName) return false;
    const tag = node.tagName.toLowerCase();
    return /^h[1-6]$/.test(tag);
  }

  function buildIndex() {
    index = [];
    counter = 0;

    const root = document.body || document.documentElement;
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          if (!node.tagName) return NodeFilter.FILTER_SKIP;
          const tag = node.tagName.toLowerCase();
          if (isHeadingElement(node) || tag === 'p') return NodeFilter.FILTER_ACCEPT;
          return NodeFilter.FILTER_SKIP;
        },
      }
    );

    let lastHeading = null;
    let current;
    while ((current = walker.nextNode())) {
      const tag = current.tagName.toLowerCase();
      if (isHeadingElement(current)) {
        const title = normalizeText(current.textContent);
        const id = ensureElementId(current);
        const level = tag;
        index.push({ id, title, level, node: current, searchText: title });
        lastHeading = current;
        lastHeading._extTitle = title;
      } else if (tag === 'p') {
        if (!lastHeading) continue; // only paragraphs under a heading
        const text = normalizeText(current.textContent);
        if (!text || text.length < 20) continue; // skip very short/noisy paragraphs
        const id = ensureElementId(current);
        const parentTitle = lastHeading._extTitle || normalizeText(lastHeading.textContent) || '';
        index.push({
          id,
          title: text,
          level: 'p',
          node: current,
          parentTitle,
          searchText: (parentTitle ? parentTitle + ' ' : '') + text,
        });
      }
    }

    isIndexed = true;
  }

  function scoreItem(queryLower, item) {
    const base = item.level && item.level[0] === 'h' ? 5 : 0; // favor headings slightly
    const haystack = (item.searchText || item.title || '').toLowerCase();
    if (!queryLower) return 1 + base; // neutral order with slight heading bias
    if (haystack === queryLower) return 100 + base;
    if (haystack.startsWith(queryLower)) return 80 + base;
    const idx = haystack.indexOf(queryLower);
    if (idx >= 0) return 60 - Math.min(idx, 50) + base;
    // rough subsequence fuzzy match
    let qi = 0;
    for (let i = 0; i < haystack.length && qi < queryLower.length; i++) {
      if (haystack[i] === queryLower[qi]) qi++;
    }
    if (qi === queryLower.length) return 30 + base;
    return -1;
  }

  function getSuggestions(query, limit) {
    if (!isIndexed) buildIndex();
    const q = normalizeText(query).toLowerCase();
    const scored = index
      .map((item) => ({ item, score: scoreItem(q, item) }))
      .filter((s) => s.score >= 0)
      .sort((a, b) => b.score - a.score);

    const sliced = (limit ? scored.slice(0, limit) : scored).map((s) => {
      const it = s.item;
      const isParagraph = it.level === 'p';
      const title = isParagraph
        ? ((it.parentTitle ? it.parentTitle + ' — ' : '') + truncateForDisplay(it.title))
        : it.title;
      return {
        id: it.id,
        title,
        level: it.level,
      };
    });
    return sliced;
  }

  function smoothScrollTo(node) {
    try {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (_) {
      node.scrollIntoView(true);
    }
  }

  function highlight(node) {
    node.classList.add(HIGHLIGHT_CLASS);
    setTimeout(() => node.classList.remove(HIGHLIGHT_CLASS), 2000);
  }

  function scrollToId(id) {
    let el = document.querySelector(`[${MARK_ATTR}="${CSS.escape(id)}"]`);
    if (!el) {
      buildIndex();
      el = document.querySelector(`[${MARK_ATTR}="${CSS.escape(id)}"]`);
    }
    if (el) {
      smoothScrollTo(el);
      highlight(el);
      return true;
    }
    return false;
  }

  function maybeReindexOnMutation() {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'childList' || m.type === 'characterData') {
          isIndexed = false;
          break;
        }
      }
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildIndex, { once: true });
  } else {
    buildIndex();
  }
  maybeReindexOnMutation();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'PAGE_JUMP_GET_SUGGESTIONS') {
      const { query = '', limit = 20 } = message;
      const suggestions = getSuggestions(query, limit);
      sendResponse({ suggestions });
      return true;
    }

    if (message.type === 'PAGE_JUMP_SCROLL_TO') {
      const { id } = message;
      const ok = scrollToId(id);
      sendResponse({ ok });
      return true;
    }
  });
})(); 