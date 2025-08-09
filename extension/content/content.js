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

  function getElementSearchText(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';

    const pieces = [];

    const visible = (el.innerText || el.textContent || '').trim();
    if (visible) pieces.push(visible);

    const aria = el.getAttribute('aria-label');
    if (aria) pieces.push(aria);
    const title = el.getAttribute('title');
    if (title) pieces.push(title);

    if (el.tagName === 'IMG') {
      const alt = el.getAttribute('alt');
      if (alt) pieces.push(alt);
    }

    // URLs (links, embeds)
    const urlAttrs = [];
    if (el.tagName === 'A') urlAttrs.push(el.getAttribute('href'));
    if (el.tagName === 'IFRAME') urlAttrs.push(el.getAttribute('src'));
    if (el.tagName === 'EMBED') urlAttrs.push(el.getAttribute('src'));
    if (el.tagName === 'OBJECT') urlAttrs.push(el.getAttribute('data'));

    for (const href of urlAttrs) {
      if (!href) continue;
      try {
        const u = new URL(href, location.href);
        const last = (u.pathname || '').split('/').filter(Boolean).pop() || '';
        if (last) {
          pieces.push(last);
          const dot = last.lastIndexOf('.');
          if (dot > 0) pieces.push(last.slice(0, dot));
        }
      } catch (_) {}
    }

    return pieces
      .map((s) => s.replace(/\s+/g, ' '))
      .filter(Boolean)
      .join(' \u2003 ');
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

  function getFrameKey() {
    try {
      return location.href;
    } catch {
      return 'about:blank';
    }
  }

  function indexPdfTextLayers(lastHeading) {
    const layers = Array.from(document.querySelectorAll('.textLayer'));
    for (const layer of layers) {
      const text = normalizeText(layer.innerText);
      if (!text || text.length < 20) continue;
      const id = ensureElementId(layer);
      let parentTitle = 'PDF';
      const page = layer.closest('.page');
      const pageNum = page && (page.getAttribute('data-page-number') || page.getAttribute('data-page-index'));
      if (pageNum) parentTitle = `PDF page ${pageNum}`;
      if (lastHeading && lastHeading._extTitle) parentTitle = lastHeading._extTitle;
      index.push({
        id,
        title: text,
        level: 'pdf',
        node: layer,
        parentTitle,
        searchText: (parentTitle ? parentTitle + ' ' : '') + text,
      });
    }
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
          if (isHeadingElement(node) || tag === 'p' || tag === 'a' || tag === 'iframe' || tag === 'embed' || tag === 'object') return NodeFilter.FILTER_ACCEPT;
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
        if (!lastHeading) continue;
        const text = normalizeText(current.textContent);
        if (!text || text.length < 20) continue;
        const id = ensureElementId(current);
        const parentTitle = lastHeading._extTitle || normalizeText(lastHeading.textContent) || '';
        index.push({ id, title: text, level: 'p', node: current, parentTitle, searchText: (parentTitle ? parentTitle + ' ' : '') + text });
      } else if (tag === 'a' || tag === 'iframe' || tag === 'embed' || tag === 'object') {
        if (!lastHeading) continue;
        const rich = normalizeText(getElementSearchText(current));
        if (!rich) continue;
        const id = ensureElementId(current);
        const parentTitle = lastHeading._extTitle || normalizeText(lastHeading.textContent) || '';
        const level = tag === 'a' ? 'a' : 'embed';
        index.push({ id, title: rich, level, node: current, parentTitle, searchText: (parentTitle ? parentTitle + ' ' : '') + rich });
      }
    }

    indexPdfTextLayers(lastHeading);

    isIndexed = true;
  }

  function scoreItem(queryLower, item) {
    const base = item.level && (item.level[0] === 'h' || item.level === 'pdf') ? 5 : 0;
    const haystack = (item.searchText || item.title || '').toLowerCase();
    if (!queryLower) return 1 + base;
    if (haystack === queryLower) return 100 + base;
    if (haystack.startsWith(queryLower)) return 80 + base;
    const idx = haystack.indexOf(queryLower);
    if (idx >= 0) return 60 - Math.min(idx, 50) + base;
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
    const frameKey = getFrameKey();
    const scored = index
      .map((item) => ({ item, score: scoreItem(q, item) }))
      .filter((s) => s.score >= 0)
      .sort((a, b) => b.score - a.score);

    const sliced = (limit ? scored.slice(0, limit) : scored).map((s) => {
      const it = s.item;
      const isParagraph = it.level === 'p';
      const isLink = it.level === 'a' || it.level === 'embed';
      const isPdf = it.level === 'pdf';
      const title = (isParagraph || isLink || isPdf)
        ? ((it.parentTitle ? it.parentTitle + ' — ' : '') + truncateForDisplay(it.title))
        : it.title;
      return {
        id: `${frameKey}::${it.id}`,
        rawId: it.id,
        frameHref: frameKey,
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
    let rawId = id;
    const delim = id.indexOf('::');
    if (delim > 0) rawId = id.slice(delim + 2);

    let el = document.querySelector(`[${MARK_ATTR}="${CSS.escape(rawId)}"]`);
    if (!el) {
      buildIndex();
      el = document.querySelector(`[${MARK_ATTR}="${CSS.escape(rawId)}"]`);
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