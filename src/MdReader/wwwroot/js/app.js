/*
 * MdReader — 뷰어 UI
 * C# 호스트(WebView2)와 메시지를 주고받으며 문서를 렌더링한다.
 *
 * 호스트 → 페이지: settings, tabs, load, welcome, index, resolved, scrollTo,
 *                  backlinks, searchResults, toast, error
 * 페이지 → 호스트: ready, newTab, closeTab, switchTab, reopenTab, open, openPath, openRel,
 *                  navigate, navigateHref, external, resolve, back, forward, reload,
 *                  backlinks, search, setting, themeApplied, showInFolder, openInObsidian,
 *                  registerOpenWith, (drop: postMessageWithAdditionalObjects)
 */
(function () {
  'use strict';

  const V = window.MdVendor || {};
  const renderer = window.ObsidianMarkdown.create({ katex: V.katex, hljs: V.hljs, yaml: V.yaml });
  const purify = V.DOMPurify;

  const $ = (s) => document.querySelector(s);
  const docEl = $('#doc');
  const mainEl = $('#main');
  const tocList = $('#toc-list');

  const webview = window.chrome && window.chrome.webview;
  function send(msg) {
    if (webview) webview.postMessage(msg);
    else if (window.__mockHost) window.__mockHost(msg);
  }

  const state = {
    doc: null,              // 현재 load 메시지 (path, vaultKey, ...)
    tabs: [],
    activeTab: null,
    indexes: new Map(),     // vaultKey → { paths, set, tree }
    expanded: new Map(),    // vaultKey → Set(폴더 경로)
    zoom: 1,
    theme: 'system',
    sidebarVisible: true,
    sidebarPane: 'files',
    sidebarWidth: 260,
    cssSnippets: true,
    restoreSession: true,
    hoverPreview: true,
    recent: [],
    previewCache: new Map(), // 링크 대상 → resolved 메시지
    pending: new Map(),
    reqSeq: 0,
    backlinksFor: null,
    searchReq: null,
    mermaidLoading: null
  };

  const nav = (extra) => Object.assign({ scroll: mainEl.scrollTop }, extra);
  const esc = renderer.esc;

  // ───────────── 노트 인덱스 ─────────────
  function setIndex(vaultKey, paths) {
    const set = new Set();
    for (const raw of paths || []) {
      const p = raw.replace(/\\/g, '/').toLowerCase();
      const isMd = /\.md$/.test(p);
      const noExt = isMd ? p.slice(0, -3) : p;
      set.add(noExt);
      set.add(noExt.split('/').pop());
      if (isMd) set.add(p);
    }
    state.indexes.set(vaultKey, { paths: paths || [], set, tree: null });
  }
  function currentIndex() {
    return state.doc ? state.indexes.get(state.doc.vaultKey) : null;
  }
  function isResolved(name) {
    const idx = currentIndex();
    if (!idx) return true;
    const t = name.replace(/\\/g, '/').replace(/^\.?\//, '').trim().toLowerCase();
    if (!t) return true;
    const noMd = t.replace(/\.md$/, '');
    if (idx.set.has(noMd) || idx.set.has(t)) return true;
    if (noMd.includes('/')) {
      for (const k of idx.set) if (k.endsWith('/' + noMd)) return true;
    }
    return false;
  }

  // ───────────── 렌더링 ─────────────
  const PURIFY_CFG = {
    ADD_TAGS: ['iframe', 'details', 'summary'],
    ADD_ATTR: ['target', 'allowfullscreen', 'frameborder', 'open', 'checked', 'disabled'],
    FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select'],
    ALLOW_DATA_ATTR: true
  };
  const sanitize = (html) => (purify ? purify.sanitize(html, PURIFY_CFG) : html);
  const ABS_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
  const safeDecode = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };

  /** HTML 문자열 → 후처리된 DocumentFragment (이미지는 아직 로드되지 않음) */
  function buildFragment(html, ctx) {
    const tpl = document.createElement('template');
    tpl.innerHTML = sanitize(html);
    const root = tpl.content;
    root.querySelectorAll('img[src], video[src], audio[src], source[src]').forEach((el) => {
      const src = el.getAttribute('src');
      if (!src || ABS_URL.test(src) || src.startsWith('#')) return;
      el.setAttribute('data-embed', safeDecode(src));
      el.setAttribute('data-relative', '1');
      el.removeAttribute('src');
    });
    root.querySelectorAll('img[alt]').forEach((img) => {
      const m = /^(.*?)\|(\d+)(?:x(\d+))?$/.exec(img.getAttribute('alt'));
      if (!m) return;
      img.setAttribute('alt', m[1]);
      img.setAttribute('width', m[2]);
      if (m[3]) img.setAttribute('height', m[3]);
    });
    root.querySelectorAll('[data-embed]').forEach((el) => {
      el.setAttribute('data-from', ctx.from);
      el.setAttribute('data-depth', String(ctx.depth));
    });
    root.querySelectorAll('a[href]').forEach((a) => {
      if (/^(https?:|mailto:)/i.test(a.getAttribute('href'))) a.classList.add('external-link');
    });
    return root;
  }

  function cssClassesFrom(fm) {
    if (!fm) return [];
    const raw = fm.cssclasses || fm.cssclass || fm.cssClasses;
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,\s]+/) : [];
    return list.map(String).filter((c) => /^[\w-]+$/.test(c));
  }

  function renderDoc(msg) {
    const prev = state.doc;
    state.doc = msg;
    state.pending.clear();
    if (msg.recent) state.recent = msg.recent;
    hidePreview(true);
    if (!prev || prev.path !== msg.path) state.previewCache.clear();
    if (msg.notes) setIndex(msg.vaultKey, msg.notes);
    $('#vault-css').textContent = msg.css || '';

    const sameDoc = prev && prev.path === msg.path && prev.tabId === msg.tabId;
    const keepScroll = msg.keepScroll && sameDoc ? mainEl.scrollTop : null;
    const out = renderer.render(msg.markdown, { isResolved });

    docEl.className = 'markdown-body markdown-preview-view markdown-rendered ' + cssClassesFrom(out.frontmatter).join(' ');
    docEl.replaceChildren(buildFragment(out.html, { from: msg.path, depth: 0 }));
    docEl.hidden = false;
    $('#welcome').hidden = true;
    applyZoom();

    $('#file-name').textContent = msg.name || 'MdReader';
    $('#vault-name').textContent = msg.vaultName ? msg.vaultName + ' /' : '';
    $('#vault-name').title = msg.relPath || '';
    $('#menu-obsidian').hidden = !msg.isVault;
    document.title = (msg.name || 'MdReader') + ' — MdReader';
    setHistory(msg);

    resolveEmbeds(docEl);
    buildToc();
    renderMermaid(docEl);

    if (keepScroll !== null) mainEl.scrollTop = keepScroll;
    else if (msg.anchor) requestAnimationFrame(() => scrollToAnchor(msg.anchor));
    else restoreScroll(msg.scroll || 0);
    if (msg.restored && !msg.anchor && !msg.find) toast('마지막으로 읽던 위치에서 열었습니다 (Home: 맨 위로)');

    if (msg.find) {
      $('#find-input').value = msg.find;
      openFind(true);
    } else if (!$('#findbar').hidden && $('#find-input').value) {
      runFind(false);
    }

    renderFiles(true);
    if (!sameDoc) {
      state.backlinksFor = null;
      $('#bl-badge').hidden = true;
    }
    if (state.sidebarVisible && state.sidebarPane === 'backlinks') requestBacklinks();
  }

  // ───────────── 임베드 해석 ─────────────
  const MAX_EMBED_DEPTH = 4;

  function resolveEmbeds(container) {
    container.querySelectorAll('[data-embed]:not([data-req])').forEach((el) => {
      const depth = +el.getAttribute('data-depth') || 0;
      if (depth >= MAX_EMBED_DEPTH) { markBroken(el, '임베드 깊이 제한'); return; }
      const id = 'r' + (++state.reqSeq);
      el.setAttribute('data-req', id);
      state.pending.set(id, { el, depth });
      send({
        type: 'resolve', id,
        target: el.getAttribute('data-embed'),
        relative: el.hasAttribute('data-relative'),
        from: el.getAttribute('data-from') || (state.doc && state.doc.path)
      });
    });
  }

  function markBroken(el, why) {
    const span = document.createElement('span');
    span.className = 'embed-missing';
    span.textContent = '⚠ ' + (el.getAttribute('data-embed') || '') + (why ? ' — ' + why : '');
    el.replaceWith(span);
  }

  function onResolved(msg) {
    if (msg.id && msg.id.startsWith('p')) { onPreviewResolved(msg); return; }
    const job = state.pending.get(msg.id);
    if (!job) return;
    state.pending.delete(msg.id);
    const el = job.el;
    if (!el.isConnected) return;
    if (!msg.found) { markBroken(el, '찾을 수 없음'); return; }

    const tag = el.tagName.toLowerCase();
    if (['img', 'video', 'audio', 'source'].includes(tag) && msg.url) {
      el.setAttribute('src', msg.url);
      if (tag === 'source' && el.parentElement && el.parentElement.load) el.parentElement.load();
      return;
    }

    const kind = msg.kind;
    const alias = el.getAttribute('data-alias') || '';
    const width = el.getAttribute('data-width');
    let node;
    if (kind === 'image') {
      node = document.createElement('img');
      node.className = 'embed-image';
      node.src = msg.url;
      node.alt = alias || msg.name;
      if (width) node.width = +width;
    } else if (kind === 'audio' || kind === 'video') {
      node = document.createElement(kind);
      node.controls = true;
      node.src = msg.url;
      node.className = 'embed-media';
    } else if (kind === 'pdf') {
      node = document.createElement('iframe');
      node.className = 'embed-pdf';
      node.src = msg.url;
    } else if (kind === 'note') {
      node = buildNoteEmbed(msg, el, job.depth);
    } else {
      node = document.createElement('a');
      node.className = 'internal-link embed-file';
      node.href = '#';
      node.setAttribute('data-href', el.getAttribute('data-embed'));
      node.textContent = '📎 ' + (alias || msg.name);
    }
    const p = el.parentElement;
    const isBlock = node.tagName === 'DIV' || node.tagName === 'IFRAME';
    if (isBlock && p && p.tagName === 'P' && p.childNodes.length === 1) p.replaceWith(node);
    else el.replaceWith(node);
  }

  function buildNoteEmbed(msg, el, depth) {
    const target = el.getAttribute('data-embed');
    const hash = target.indexOf('#');
    const sub = hash >= 0 ? target.slice(hash + 1) : '';
    let md = msg.markdown || '';
    if (sub) {
      const part = renderer.extractSection(md, sub);
      md = part == null ? '> [!warning] 구간을 찾을 수 없음: ' + sub : part;
    }
    const wrap = document.createElement('div');
    wrap.className = 'embed-note markdown-embed';
    wrap.dataset.from = msg.path;
    const head = document.createElement('div');
    head.className = 'embed-note-title';
    const link = document.createElement('a');
    link.className = 'internal-link';
    link.href = '#';
    link.setAttribute('data-href', target);
    link.textContent = msg.name + (sub ? ' › ' + sub : '');
    head.appendChild(link);
    const body = document.createElement('div');
    body.className = 'embed-note-body markdown-body markdown-embed-content';
    const out = renderer.render(md, { isResolved, showProperties: false, headingIds: Object.create(null) });
    body.appendChild(buildFragment(out.html, { from: msg.path, depth: depth + 1 }));
    body.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    wrap.append(head, body);
    queueMicrotask(() => { resolveEmbeds(body); renderMermaid(body); });
    return wrap;
  }

  // ───────────── Mermaid (지연 로드) ─────────────
  function loadMermaid() {
    if (window.mermaid) return Promise.resolve(window.mermaid);
    if (!state.mermaidLoading) {
      state.mermaidLoading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'vendor/mermaid.min.js';
        s.onload = () => resolve(window.mermaid);
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }
    return state.mermaidLoading;
  }

  async function renderMermaid(container) {
    const nodes = [...container.querySelectorAll('pre.mermaid:not([data-processed])')];
    if (!nodes.length) return;
    try {
      const mermaid = await loadMermaid();
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: isDark() ? 'dark' : 'default', fontFamily: 'inherit' });
      await mermaid.run({ nodes, suppressErrors: true });
    } catch (e) {
      console.warn('mermaid', e);
    }
  }

  function rerenderMermaid() {
    docEl.querySelectorAll('pre.mermaid[data-processed]').forEach((pre) => {
      pre.removeAttribute('data-processed');
      pre.textContent = pre.getAttribute('data-source') || '';
    });
    renderMermaid(docEl);
  }

  // ───────────── 읽던 위치 ─────────────
  let scrollReportTimer = null;
  let programmaticScroll = false;
  let userScrolledSinceLoad = false;

  /** 이미지가 늦게 로드되면 문서 높이가 바뀌므로 잠시 뒤 한 번 더 맞춘다 */
  function restoreScroll(y) {
    userScrolledSinceLoad = false;
    programmaticScroll = true;
    mainEl.scrollTop = y;
    if (y > 0) {
      setTimeout(() => { if (!userScrolledSinceLoad) { programmaticScroll = true; mainEl.scrollTop = y; } }, 450);
      setTimeout(() => { if (!userScrolledSinceLoad) { programmaticScroll = true; mainEl.scrollTop = y; } }, 1200);
    }
  }

  mainEl.addEventListener('scroll', () => {
    if (programmaticScroll) { programmaticScroll = false; } else { userScrolledSinceLoad = true; }
    hidePreview(true);
    if (!state.doc) return;
    clearTimeout(scrollReportTimer);
    scrollReportTimer = setTimeout(() => send({ type: 'scrollPos', scroll: mainEl.scrollTop }), 700);
  }, { passive: true });

  // ───────────── 링크 미리보기 ─────────────
  const previewEl = $('#preview');
  const preview = { timer: null, hideTimer: null, anchor: null, reqId: null };

  function hidePreview(immediate) {
    clearTimeout(preview.timer);
    clearTimeout(preview.hideTimer);
    const go = () => { previewEl.hidden = true; preview.anchor = null; preview.reqId = null; };
    if (immediate) go(); else preview.hideTimer = setTimeout(go, 280);
  }

  function placePreview(a) {
    const r = a.getBoundingClientRect();
    const W = Math.min(480, window.innerWidth - 24);
    previewEl.style.width = W + 'px';
    previewEl.hidden = false;
    const H = previewEl.offsetHeight;
    let left = Math.min(Math.max(12, r.left), window.innerWidth - W - 12);
    let top = r.bottom + 8;
    if (top + H > window.innerHeight - 12 && r.top - H - 8 > 12) top = r.top - H - 8;
    previewEl.style.left = left + 'px';
    previewEl.style.top = Math.max(12, top) + 'px';
  }

  function fillPreview(a, title, target, from, build) {
    previewEl.dataset.from = from || (state.doc && state.doc.path) || '';
    const head = previewEl.querySelector('.hp-title');
    head.textContent = title;
    head.setAttribute('data-href', target);
    const body = previewEl.querySelector('.hp-body');
    body.replaceChildren();
    build(body);
    body.scrollTop = 0;
    placePreview(a);
  }

  function renderPreviewMarkdown(body, md, from) {
    const out = renderer.render(md, { isResolved, showProperties: false, headingIds: Object.create(null) });
    body.appendChild(buildFragment(out.html, { from, depth: 1 }));
    body.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    resolveEmbeds(body);
    renderMermaid(body);
  }

  function showPreview(a) {
    if (!state.doc || !a.isConnected) return;
    const target = a.getAttribute('data-href') || '';
    if (!target) return;
    preview.anchor = a;
    const hostNote = a.closest('.embed-note');
    const from = (hostNote && hostNote.dataset.from) || state.doc.path;

    // 같은 문서 안의 제목/블록
    if (target.startsWith('#')) {
      const part = renderer.extractSection(state.doc.markdown, target.slice(1));
      fillPreview(a, state.doc.name + ' › ' + target.slice(1), target, from, (body) => {
        if (part == null) body.innerHTML = '<div class="hp-empty">구간을 찾을 수 없습니다.</div>';
        else renderPreviewMarkdown(body, part, state.doc.path);
      });
      return;
    }
    if (a.classList.contains('is-unresolved')) {
      fillPreview(a, target, target, from, (body) => {
        body.innerHTML = '<div class="hp-empty">아직 만들어지지 않은 노트입니다.</div>';
      });
      return;
    }
    const cached = state.previewCache.get(from + '|' + target);
    if (cached) { onPreviewResolved(Object.assign({}, cached, { id: null }), a); return; }

    preview.reqId = 'p' + (++state.reqSeq);
    preview.pendingKey = from + '|' + target;
    send({ type: 'resolve', id: preview.reqId, target, relative: false, from });
  }

  function onPreviewResolved(msg, anchorOverride) {
    const a = anchorOverride || preview.anchor;
    if (!anchorOverride) {
      if (msg.id !== preview.reqId) return;
      state.previewCache.set(preview.pendingKey, msg);
    }
    if (!a || !a.isConnected) return;
    const target = a.getAttribute('data-href') || '';
    const hostNote = a.closest('.embed-note');
    const from = (hostNote && hostNote.dataset.from) || state.doc.path;
    const hash = target.indexOf('#');
    const sub = hash >= 0 ? target.slice(hash + 1) : '';
    const title = msg.found ? (msg.name || target) + (sub ? ' › ' + sub : '') : target;
    fillPreview(a, title, target, from, (body) => {
      if (!msg.found) { body.innerHTML = '<div class="hp-empty">찾을 수 없습니다.</div>'; return; }
      if (msg.kind === 'image') {
        const img = document.createElement('img');
        img.src = msg.url; img.alt = msg.name; img.className = 'hp-image';
        img.onload = () => placePreview(a);
        body.appendChild(img);
        return;
      }
      if (msg.kind !== 'note') { body.innerHTML = '<div class="hp-empty">미리볼 수 없는 파일입니다: ' + esc(msg.name) + '</div>'; return; }
      let md = msg.markdown || '';
      if (sub) {
        const part = renderer.extractSection(md, sub);
        if (part == null) { body.innerHTML = '<div class="hp-empty">구간을 찾을 수 없습니다: ' + esc(sub) + '</div>'; return; }
        md = part;
      }
      if (!md.trim()) { body.innerHTML = '<div class="hp-empty">빈 노트입니다.</div>'; return; }
      renderPreviewMarkdown(body, md, msg.path);
    });
  }

  document.addEventListener('mouseover', (e) => {
    if (!state.hoverPreview) return;
    if (e.target.closest('#preview')) { clearTimeout(preview.hideTimer); return; }
    const a = e.target.closest('#doc a.internal-link');
    if (!a || a.classList.contains('embed-file')) return;
    if (a === preview.anchor && !previewEl.hidden) { clearTimeout(preview.hideTimer); return; }
    clearTimeout(preview.timer);
    clearTimeout(preview.hideTimer);
    preview.timer = setTimeout(() => showPreview(a), 380);
  });
  document.addEventListener('mouseout', (e) => {
    const from = e.target.closest('#doc a.internal-link, #preview');
    if (!from) return;
    const to = e.relatedTarget;
    if (to && to.closest && (to.closest('#preview') || from.contains(to) || (preview.anchor && preview.anchor.contains(to)))) return;
    clearTimeout(preview.timer);
    if (!previewEl.hidden) hidePreview(false);
  });

  // ───────────── 빠른 이동 (Ctrl+P) ─────────────
  const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
  function choseong(s) {
    let out = '';
    for (const ch of s) {
      const c = ch.charCodeAt(0);
      out += c >= 0xAC00 && c <= 0xD7A3 ? CHO[Math.floor((c - 0xAC00) / 588)] : ch.toLowerCase();
    }
    return out;
  }
  /** 순서대로 들어 있는 글자 매칭 점수 (-1 = 불일치) */
  function fuzzyScore(q, s) {
    if (!q) return 0;
    const sub = s.indexOf(q);
    if (sub >= 0) return 100 - sub + (sub === 0 ? 50 : 0) - s.length * 0.05;
    let qi = 0, score = 0, last = -2;
    for (let i = 0; i < s.length && qi < q.length; i++) {
      if (s[i] !== q[qi]) continue;
      score += last === i - 1 ? 4 : 1;
      if (i === 0 || /[\s\/_\-.]/.test(s[i - 1])) score += 3;
      last = i; qi++;
    }
    return qi === q.length ? score - s.length * 0.05 : -1;
  }

  const sw = { items: [], sel: 0 };
  function switcherItems() {
    const idx = currentIndex();
    if (!idx) return [];
    if (!idx.items) {
      idx.items = idx.paths.filter((p) => VIEWABLE.test(p)).map((p) => {
        const name = p.split('/').pop().replace(/\.(md|markdown|mdown|mkd|txt)$/i, '');
        return { rel: p, name, dir: p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '', lname: name.toLowerCase(), lpath: p.toLowerCase(), cho: choseong(name) };
      });
    }
    return idx.items;
  }

  function openSwitcher() {
    hidePreview(true);
    $('#switcher').hidden = false;
    const inp = $('#sw-input');
    inp.value = '';
    renderSwitcher();
    inp.focus();
  }
  function closeSwitcher() { $('#switcher').hidden = true; }

  function renderSwitcher() {
    const q = $('#sw-input').value.trim().toLowerCase();
    const choMode = /^[ㄱ-ㅎ]+$/.test(q);
    const list = [];
    const all = switcherItems();
    if (!q) {
      const vaultRoot = state.doc && state.doc.vaultRoot ? state.doc.vaultRoot.replace(/\\/g, '/').toLowerCase() : null;
      for (const p of state.recent) {
        if (state.doc && p === state.doc.path) continue;
        const norm = p.replace(/\\/g, '/');
        list.push({ path: p, name: norm.split('/').pop().replace(/\.md$/i, ''), dir: norm.slice(0, norm.lastIndexOf('/')), recent: true,
          inVault: vaultRoot && norm.toLowerCase().startsWith(vaultRoot + '/') });
        if (list.length >= 8) break;
      }
      const shown = new Set(list.map((x) => x.name.toLowerCase()));
      for (const it of all.slice().sort((a, b) => collator.compare(a.name, b.name))) {
        if (list.length >= 60) break;
        if (!shown.has(it.lname)) list.push(it);
      }
    } else {
      const scored = [];
      for (const it of all) {
        let sc = choMode ? fuzzyScore(q, it.cho) : Math.max(fuzzyScore(q, it.lname) * 2, fuzzyScore(q, it.lpath));
        if (sc >= 0) scored.push([sc, it]);
      }
      scored.sort((a, b) => b[0] - a[0] || collator.compare(a[1].name, b[1].name));
      for (const [, it] of scored.slice(0, 60)) list.push(it);
    }
    sw.items = list;
    sw.sel = 0;
    const ul = $('#sw-list');
    ul.replaceChildren();
    if (!list.length) {
      ul.innerHTML = '<li class="sw-empty">' + (state.doc ? '일치하는 노트가 없습니다.' : '먼저 문서를 하나 열면 같은 볼트의 노트로 이동할 수 있습니다.') + '</li>';
      return;
    }
    list.forEach((it, i) => {
      const li = document.createElement('li');
      li.className = 'sw-item' + (i === 0 ? ' sel' : '');
      li.dataset.i = i;
      li.innerHTML = '<span class="sw-name"></span><span class="sw-dir"></span>';
      li.querySelector('.sw-name').innerHTML = (it.recent ? '<span class="sw-recent">최근</span>' : '') + highlightFuzzy(it.name, q, choMode);
      li.querySelector('.sw-dir').textContent = it.dir;
      ul.appendChild(li);
    });
  }

  function highlightFuzzy(name, q, choMode) {
    if (!q) return esc(name);
    const target = choMode ? choseong(name) : name.toLowerCase();
    const marks = new Set();
    const sub = target.indexOf(q);
    if (sub >= 0) for (let i = 0; i < q.length; i++) marks.add(sub + i);
    else {
      let qi = 0;
      for (let i = 0; i < target.length && qi < q.length; i++) if (target[i] === q[qi]) { marks.add(i); qi++; }
    }
    let out = '';
    [...name].forEach((ch, i) => { out += marks.has(i) ? '<b>' + esc(ch) + '</b>' : esc(ch); });
    return out;
  }

  function moveSel(d) {
    if (!sw.items.length) return;
    const lis = $('#sw-list').children;
    lis[sw.sel] && lis[sw.sel].classList.remove('sel');
    sw.sel = (sw.sel + d + sw.items.length) % sw.items.length;
    lis[sw.sel].classList.add('sel');
    lis[sw.sel].scrollIntoView({ block: 'nearest' });
  }

  function openSel(newTab) {
    const it = sw.items[sw.sel];
    if (!it) return;
    closeSwitcher();
    if (it.rel) send(nav({ type: 'openRel', vaultKey: state.doc.vaultKey, rel: it.rel, newTab }));
    else send(nav({ type: 'openPath', path: it.path, newTab }));
  }

  $('#sw-input').addEventListener('input', renderSwitcher);
  $('#sw-input').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); openSel(e.ctrlKey || e.metaKey); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSwitcher(); }
    e.stopPropagation();
  });
  $('#sw-list').addEventListener('mousemove', (e) => {
    const li = e.target.closest('.sw-item');
    if (li && +li.dataset.i !== sw.sel) moveSel(+li.dataset.i - sw.sel);
  });
  $('#sw-list').addEventListener('click', (e) => {
    const li = e.target.closest('.sw-item');
    if (li) { sw.sel = +li.dataset.i; openSel(e.ctrlKey || e.metaKey); }
  });
  $('#switcher').addEventListener('mousedown', (e) => { if (e.target.id === 'switcher') closeSwitcher(); });

  // ───────────── 탭 ─────────────
  function renderTabs(msg) {
    state.tabs = msg.tabs || [];
    state.activeTab = msg.active;
    const box = $('#tabs');
    box.replaceChildren();
    for (const t of state.tabs) {
      const el = document.createElement('div');
      el.className = 'tab' + (t.id === state.activeTab ? ' active' : '') + (t.path ? '' : ' empty');
      el.dataset.id = t.id;
      el.title = t.path || '새 탭';
      el.setAttribute('role', 'tab');
      el.innerHTML = '<span class="tab-title"></span><button class="tab-close" title="닫기 (Ctrl+W)">' +
        '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg></button>';
      el.querySelector('.tab-title').textContent = t.title;
      box.appendChild(el);
    }
    const active = box.querySelector('.tab.active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function cycleTab(delta) {
    if (state.tabs.length < 2) return;
    const i = state.tabs.findIndex((t) => t.id === state.activeTab);
    const next = state.tabs[(i + delta + state.tabs.length) % state.tabs.length];
    send(nav({ type: 'switchTab', id: next.id }));
  }

  function gotoTabIndex(n) {
    const t = n === 9 ? state.tabs[state.tabs.length - 1] : state.tabs[n - 1];
    if (t && t.id !== state.activeTab) send(nav({ type: 'switchTab', id: t.id }));
  }

  $('#tabs').addEventListener('mousedown', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    const id = +tab.dataset.id;
    if (e.button === 1) { e.preventDefault(); send(nav({ type: 'closeTab', id })); return; }
    if (e.button !== 0) return;
    if (e.target.closest('.tab-close')) { send(nav({ type: 'closeTab', id })); return; }
    if (id !== state.activeTab) send(nav({ type: 'switchTab', id }));
  });
  $('#tabs').addEventListener('wheel', (e) => {
    if (e.ctrlKey) return;
    $('#tabs').scrollLeft += e.deltaY;
  }, { passive: true });

  // ───────────── 사이드바 ─────────────
  function setSidebar(visible, pane, persist) {
    if (pane) state.sidebarPane = pane;
    state.sidebarVisible = visible;
    document.body.classList.toggle('sidebar-hidden', !visible);
    $('#btn-sidebar').classList.toggle('on', visible);
    document.querySelectorAll('.sb-tab').forEach((b) => b.classList.toggle('active', b.dataset.pane === state.sidebarPane));
    document.querySelectorAll('.sb-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === state.sidebarPane));
    if (persist) {
      send({ type: 'setting', key: 'sidebarVisible', value: visible });
      if (pane) send({ type: 'setting', key: 'sidebarPane', value: state.sidebarPane });
    }
    if (visible && state.sidebarPane === 'backlinks') requestBacklinks();
    if (visible && state.sidebarPane === 'files') renderFiles(true);
  }

  function showPane(pane, focus) {
    // 같은 탭을 다시 누르면 사이드바를 닫는다
    if (state.sidebarVisible && state.sidebarPane === pane && !focus) { setSidebar(false, null, true); return; }
    setSidebar(true, pane, true);
    if (focus) {
      const input = pane === 'search' ? $('#vault-search') : pane === 'files' ? $('#file-filter') : null;
      if (input) { input.focus(); input.select(); }
    }
  }

  document.querySelector('.sb-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.sb-tab');
    if (b) showPane(b.dataset.pane, false);
  });

  function applySidebarWidth() {
    document.documentElement.style.setProperty('--sidebar-w', state.sidebarWidth + 'px');
  }
  (function setupResizer() {
    const handle = $('#sb-resizer');
    let startX = 0, startW = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      dragging = true; startX = e.clientX; startW = state.sidebarWidth;
      document.body.classList.add('resizing');
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      state.sidebarWidth = Math.min(560, Math.max(180, startW + (e.clientX - startX) / (window.devicePixelRatio ? 1 : 1)));
      applySidebarWidth();
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('resizing');
      send({ type: 'setting', key: 'sidebarWidth', value: Math.round(state.sidebarWidth) });
    });
  })();

  // ── 파일 트리 ──
  const VIEWABLE = /\.(md|markdown|mdown|mkd|txt)$/i;
  const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

  function buildTree(paths) {
    const root = { name: '', path: '', dirs: new Map(), files: [] };
    for (const p of paths) {
      if (!VIEWABLE.test(p)) continue;
      const parts = p.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const name = parts[i];
        if (!node.dirs.has(name)) {
          node.dirs.set(name, { name, path: parts.slice(0, i + 1).join('/'), dirs: new Map(), files: [] });
        }
        node = node.dirs.get(name);
      }
      node.files.push({ name: parts[parts.length - 1], path: p });
    }
    return root;
  }

  function expandedSet() {
    const key = state.doc ? state.doc.vaultKey : '';
    if (!state.expanded.has(key)) state.expanded.set(key, new Set());
    return state.expanded.get(key);
  }

  function renderFiles(reveal) {
    if (!state.sidebarVisible || state.sidebarPane !== 'files') return;
    const box = $('#file-tree');
    const idx = currentIndex();
    const doc = state.doc;
    $('#files-root').textContent = doc ? (doc.isVault ? '볼트: ' + doc.vaultName : '폴더: ' + (doc.vaultRoot || '')) : '';
    if (!idx || !doc) {
      box.innerHTML = '<div class="pane-empty">문서를 열면 같은 볼트(폴더)의 파일이 여기에 표시됩니다.</div>';
      return;
    }
    const current = (doc.relPath || '').replace(/\\/g, '/');
    const filter = $('#file-filter').value.trim().toLowerCase();

    if (filter) {
      const hits = idx.paths.filter((p) => VIEWABLE.test(p) && p.toLowerCase().includes(filter))
        .sort((a, b) => collator.compare(a.split('/').pop(), b.split('/').pop())).slice(0, 400);
      box.replaceChildren();
      const ul = document.createElement('ul');
      ul.className = 'tree flat';
      for (const p of hits) {
        const li = document.createElement('li');
        li.innerHTML = '<a class="tree-file" href="#"><span class="tf-name"></span><span class="tf-dir"></span></a>';
        const a = li.firstChild;
        a.dataset.rel = p;
        if (p === current) a.classList.add('current');
        a.querySelector('.tf-name').textContent = p.split('/').pop().replace(/\.md$/i, '');
        a.querySelector('.tf-dir').textContent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
        ul.appendChild(li);
      }
      if (!hits.length) box.innerHTML = '<div class="pane-empty">일치하는 파일이 없습니다.</div>';
      else box.appendChild(ul);
      return;
    }

    if (!idx.tree) idx.tree = buildTree(idx.paths);
    const open = expandedSet();
    if (reveal && current.includes('/')) {
      const parts = current.split('/');
      for (let i = 1; i < parts.length; i++) open.add(parts.slice(0, i).join('/'));
    }

    const make = (node, depth) => {
      const ul = document.createElement('ul');
      ul.className = 'tree';
      const dirs = [...node.dirs.values()].sort((a, b) => collator.compare(a.name, b.name));
      const files = node.files.slice().sort((a, b) => collator.compare(a.name, b.name));
      for (const d of dirs) {
        const li = document.createElement('li');
        const isOpen = open.has(d.path);
        const a = document.createElement('a');
        a.href = '#';
        a.className = 'tree-dir' + (isOpen ? ' open' : '');
        a.dataset.dir = d.path;
        a.style.setProperty('--depth', depth);
        a.innerHTML = '<span class="chev"></span><span class="td-name"></span>';
        a.querySelector('.td-name').textContent = d.name;
        li.appendChild(a);
        if (isOpen) li.appendChild(make(d, depth + 1));
        ul.appendChild(li);
      }
      for (const f of files) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = '#';
        a.className = 'tree-file' + (f.path === current ? ' current' : '');
        a.dataset.rel = f.path;
        a.style.setProperty('--depth', depth);
        a.textContent = f.name.replace(/\.md$/i, '');
        li.appendChild(a);
        ul.appendChild(li);
      }
      return ul;
    };
    box.replaceChildren(make(idx.tree, 0));
    if (reveal) {
      const cur = box.querySelector('.tree-file.current');
      if (cur) cur.scrollIntoView({ block: 'nearest' });
    }
  }

  $('#file-tree').addEventListener('click', (e) => {
    const dir = e.target.closest('.tree-dir');
    if (dir) {
      e.preventDefault();
      const set = expandedSet();
      set.has(dir.dataset.dir) ? set.delete(dir.dataset.dir) : set.add(dir.dataset.dir);
      renderFiles(false);
      return;
    }
    const file = e.target.closest('.tree-file');
    if (file) {
      e.preventDefault();
      send(nav({ type: 'openRel', vaultKey: state.doc.vaultKey, rel: file.dataset.rel, newTab: e.ctrlKey || e.metaKey }));
    }
  });
  $('#file-tree').addEventListener('auxclick', (e) => {
    const file = e.target.closest('.tree-file');
    if (file && e.button === 1) { e.preventDefault(); send(nav({ type: 'openRel', vaultKey: state.doc.vaultKey, rel: file.dataset.rel, newTab: true })); }
  });
  let filterTimer = null;
  $('#file-filter').addEventListener('input', () => { clearTimeout(filterTimer); filterTimer = setTimeout(() => renderFiles(false), 120); });
  $('#file-filter').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = $('#file-tree .tree-file');
      if (first) send(nav({ type: 'openRel', vaultKey: state.doc.vaultKey, rel: first.dataset.rel, newTab: e.ctrlKey }));
    }
    if (e.key === 'Escape') { e.target.value = ''; renderFiles(true); }
  });

  // ── 볼트 검색 ──
  function highlightTerms(text, query) {
    const terms = [];
    query.replace(/"([^"]+)"|(\S+)/g, (m, q, w) => {
      let t = q || w;
      if (/^(file|tag):/i.test(t)) t = t.replace(/^tag:/i, '#').replace(/^file:.*/i, '');
      if (t) terms.push(t);
      return m;
    });
    let html = esc(text);
    for (const t of terms.sort((a, b) => b.length - a.length)) {
      const re = new RegExp(esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      html = html.replace(re, (m) => '<mark>' + m + '</mark>');
    }
    return html;
  }

  function firstTerm(query) {
    const m = /"([^"]+)"|(\S+)/.exec(query);
    if (!m) return '';
    const t = m[1] || m[2];
    if (/^file:/i.test(t)) return '';
    return t.replace(/^tag:/i, '#');
  }

  let searchTimer = null;
  function runVaultSearch(immediate) {
    clearTimeout(searchTimer);
    const q = $('#vault-search').value.trim();
    if (!q) {
      state.searchReq = null;
      $('#search-results').replaceChildren();
      $('#search-status').textContent = '여러 단어 · "구절" · #태그 · file:이름';
      return;
    }
    const go = () => {
      if (!state.doc) { $('#search-status').textContent = '먼저 볼트 안의 문서를 여세요.'; return; }
      state.searchReq = 's' + (++state.reqSeq);
      $('#search-status').textContent = '검색 중…';
      send({ type: 'search', reqId: state.searchReq, query: q });
    };
    if (immediate) go(); else searchTimer = setTimeout(go, 280);
  }

  function onSearchResults(msg) {
    if (msg.reqId !== state.searchReq) return;
    const box = $('#search-results');
    box.replaceChildren();
    if (msg.error) { $('#search-status').textContent = '⚠ ' + msg.error; return; }
    const items = msg.items || [];
    $('#search-status').textContent = items.length
      ? items.length + '개 노트' + (msg.truncated ? ' (상위 ' + items.length + '개만 표시)' : '')
      : '결과 없음';
    const term = firstTerm(msg.query);
    for (const it of items) {
      const div = document.createElement('div');
      div.className = 'sr-item';
      div.dataset.rel = it.rel;
      div.dataset.find = term;
      div.innerHTML = '<div class="sr-head"><span class="sr-name"></span><span class="sr-count"></span></div><div class="sr-path"></div>';
      div.querySelector('.sr-name').innerHTML = highlightTerms(it.name, msg.query);
      div.querySelector('.sr-count').textContent = it.count ? String(it.count) : '';
      div.querySelector('.sr-path').textContent = it.rel.includes('/') ? it.rel.slice(0, it.rel.lastIndexOf('/')) : '';
      for (const l of it.lines || []) {
        const line = document.createElement('div');
        line.className = 'sr-line';
        line.innerHTML = highlightTerms(l.text, msg.query);
        div.appendChild(line);
      }
      box.appendChild(div);
    }
  }

  $('#vault-search').addEventListener('input', () => runVaultSearch(false));
  $('#vault-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runVaultSearch(true);
    if (e.key === 'Escape') { e.target.value = ''; runVaultSearch(true); }
  });
  $('#search-results').addEventListener('click', (e) => {
    const it = e.target.closest('.sr-item');
    if (!it) return;
    send(nav({ type: 'openRel', vaultKey: state.doc.vaultKey, rel: it.dataset.rel, find: it.dataset.find, newTab: e.ctrlKey || e.metaKey }));
  });

  function searchTag(tag) {
    $('#vault-search').value = '#' + tag;
    setSidebar(true, 'search', true);
    runVaultSearch(true);
  }

  // ── 백링크 ──
  function requestBacklinks() {
    if (!state.doc || state.backlinksFor === state.doc.path) return;
    state.backlinksFor = state.doc.path;
    $('#bl-count').textContent = '';
    $('#backlinks').innerHTML = '<div class="pane-empty">찾는 중…</div>';
    send({ type: 'backlinks', reqId: 'b' + (++state.reqSeq) });
  }

  function onBacklinks(msg) {
    if (!state.doc || msg.path !== state.doc.path) return;
    const box = $('#backlinks');
    box.replaceChildren();
    const items = msg.items || [];
    $('#bl-count').textContent = items.length ? String(items.length) : '';
    $('#bl-badge').textContent = items.length > 99 ? '99+' : String(items.length);
    $('#bl-badge').hidden = items.length === 0;
    if (msg.error) { box.innerHTML = '<div class="pane-empty">⚠ ' + esc(msg.error) + '</div>'; return; }
    if (!items.length) { box.innerHTML = '<div class="pane-empty">이 노트를 가리키는 노트가 없습니다.</div>'; return; }
    const name = state.doc.name;
    for (const it of items) {
      const div = document.createElement('div');
      div.className = 'sr-item';
      div.dataset.rel = it.rel;
      div.dataset.find = name;
      div.innerHTML = '<div class="sr-head"><span class="sr-name"></span></div><div class="sr-path"></div>';
      div.querySelector('.sr-name').textContent = it.name;
      div.querySelector('.sr-path').textContent = it.rel.includes('/') ? it.rel.slice(0, it.rel.lastIndexOf('/')) : '';
      for (const l of it.lines || []) {
        const line = document.createElement('div');
        line.className = 'sr-line';
        line.innerHTML = highlightTerms(l, '"' + name + '"');
        div.appendChild(line);
      }
      box.appendChild(div);
    }
  }
  $('#backlinks').addEventListener('click', (e) => {
    const it = e.target.closest('.sr-item');
    if (!it) return;
    send(nav({ type: 'openRel', vaultKey: state.doc.vaultKey, rel: it.dataset.rel, find: it.dataset.find, newTab: e.ctrlKey || e.metaKey }));
  });

  // ───────────── 목차 ─────────────
  let tocObserver = null;
  function buildToc() {
    tocList.replaceChildren();
    const heads = [...docEl.querySelectorAll(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6')]
      .filter((h) => h.id);
    const min = Math.min(...heads.map((h) => +h.tagName[1]), 6);
    for (const h of heads) {
      const li = document.createElement('li');
      li.className = 'toc-l' + (+h.tagName[1] - min);
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = h.textContent.replace(/\s+/g, ' ').trim();
      a.dataset.target = h.id;
      li.appendChild(a);
      tocList.appendChild(li);
    }
    if (!heads.length) tocList.innerHTML = '<li class="pane-empty">제목이 없습니다.</li>';

    if (tocObserver) tocObserver.disconnect();
    tocObserver = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        tocList.querySelectorAll('a.active').forEach((x) => x.classList.remove('active'));
        const a = tocList.querySelector('a[data-target="' + CSS.escape(en.target.id) + '"]');
        if (a) { a.classList.add('active'); a.scrollIntoView({ block: 'nearest' }); }
      }
    }, { root: mainEl, rootMargin: '0px 0px -75% 0px' });
    heads.forEach((h) => tocObserver.observe(h));
  }

  // ───────────── 앵커 이동 ─────────────
  function scrollToAnchor(anchor) {
    if (!anchor) return;
    let el = null;
    const raw = safeDecode(String(anchor).replace(/^#/, ''));
    if (raw.startsWith('^')) {
      el = document.getElementById(raw);
    } else {
      const want = renderer.normHeading(raw.split('#').pop());
      el = docEl.querySelector('[data-heading="' + CSS.escape(want) + '"]') || document.getElementById(raw);
    }
    if (!el) { toast('위치를 찾을 수 없음: ' + raw); return; }
    el.scrollIntoView({ block: 'start' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  // ───────────── 문서 안 찾기 ─────────────
  const find = { hits: [], index: -1 };

  function clearFind() {
    docEl.querySelectorAll('mark.find-hit').forEach((m) => {
      const parent = m.parentNode;
      parent.replaceChild(document.createTextNode(m.textContent), m);
      parent.normalize();
    });
    find.hits = []; find.index = -1;
    $('#find-count').textContent = '';
  }

  function runFind(jump) {
    clearFind();
    const q = $('#find-input').value;
    if (!q) return;
    const needle = q.toLowerCase();
    const walker = document.createTreeWalker(docEl, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || p.closest('svg, .katex-mathml, script, style')) return NodeFilter.FILTER_REJECT;
        return n.nodeValue.toLowerCase().includes(needle) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.nodeValue;
      const lower = text.toLowerCase();
      const frag = document.createDocumentFragment();
      let last = 0, i;
      while ((i = lower.indexOf(needle, last)) !== -1) {
        frag.appendChild(document.createTextNode(text.slice(last, i)));
        const m = document.createElement('mark');
        m.className = 'find-hit';
        m.textContent = text.slice(i, i + q.length);
        frag.appendChild(m);
        find.hits.push(m);
        last = i + q.length;
      }
      frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
    find.hits.forEach((m) => { const d = m.closest('details'); if (d) d.open = true; });
    if (find.hits.length) gotoHit(0, jump !== false);
    else $('#find-count').textContent = '0/0';
  }

  function gotoHit(i, scroll) {
    if (!find.hits.length) return;
    if (find.index >= 0) find.hits[find.index].classList.remove('current');
    find.index = (i + find.hits.length) % find.hits.length;
    const m = find.hits[find.index];
    m.classList.add('current');
    if (scroll) m.scrollIntoView({ block: 'center' });
    $('#find-count').textContent = (find.index + 1) + '/' + find.hits.length;
  }

  function openFind(keepValue) {
    $('#findbar').hidden = false;
    const inp = $('#find-input');
    if (!keepValue) {
      const sel = String(window.getSelection() || '').trim();
      if (sel && sel.length < 80 && !sel.includes('\n')) inp.value = sel;
      inp.focus(); inp.select();
    }
    if (inp.value) runFind(true);
  }
  function closeFind() { $('#findbar').hidden = true; clearFind(); }

  // ───────────── 테마 / 확대 ─────────────
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const isDark = () => state.theme === 'dark' || (state.theme === 'system' && mq.matches);
  function applyTheme() {
    const dark = isDark();
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    document.body.classList.toggle('theme-dark', dark);
    document.body.classList.toggle('theme-light', !dark);
    send({ type: 'themeApplied', dark });
  }
  function setTheme(t, persist) {
    state.theme = t;
    applyTheme();
    rerenderMermaid();
    if (persist) send({ type: 'setting', key: 'theme', value: t });
  }
  mq.addEventListener('change', () => { if (state.theme === 'system') { applyTheme(); rerenderMermaid(); } });

  function applyZoom() {
    docEl.style.zoom = String(state.zoom);
    $('#zoom-label').textContent = Math.round(state.zoom * 100) + '%';
  }
  function setZoom(z) {
    state.zoom = Math.min(3, Math.max(0.5, Math.round(z * 10) / 10));
    applyZoom();
    send({ type: 'setting', key: 'zoom', value: state.zoom });
  }

  function syncMenuChecks() {
    $('#menu-snippets').classList.toggle('checked', state.cssSnippets);
    $('#menu-restore').classList.toggle('checked', state.restoreSession);
    $('#menu-preview').classList.toggle('checked', state.hoverPreview);
  }

  // ───────────── 기타 UI ─────────────
  let toastTimer = null;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }

  function setHistory(msg) {
    if ('canBack' in msg) $('#btn-back').disabled = !msg.canBack;
    if ('canForward' in msg) $('#btn-forward').disabled = !msg.canForward;
  }

  function showWelcome(msg) {
    state.doc = null;
    docEl.hidden = true;
    docEl.replaceChildren();
    $('#vault-css').textContent = '';
    buildToc();
    $('#welcome').hidden = false;
    $('#file-name').textContent = 'MdReader';
    $('#vault-name').textContent = '';
    document.title = 'MdReader';
    setHistory(msg);
    const list = $('#recent-list');
    list.replaceChildren();
    const recent = (msg && msg.recent) || [];
    $('#recent-wrap').hidden = recent.length === 0;
    for (const p of recent) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = '#';
      a.dataset.path = p;
      a.innerHTML = '<span class="r-name"></span><span class="r-path"></span>';
      a.querySelector('.r-name').textContent = p.split(/[\\/]/).pop();
      a.querySelector('.r-path').textContent = p;
      li.appendChild(a);
      list.appendChild(li);
    }
    renderFiles(false);
    $('#backlinks').innerHTML = '<div class="pane-empty">문서를 열면 백링크가 표시됩니다.</div>';
    $('#bl-badge').hidden = true;
    state.backlinksFor = null;
  }

  const commands = {
    open: () => send(nav({ type: 'open' })),
    newTab: () => send(nav({ type: 'newTab' })),
    closeTab: () => state.activeTab != null && send(nav({ type: 'closeTab', id: state.activeTab })),
    reopenTab: () => send(nav({ type: 'reopenTab' })),
    nextTab: () => cycleTab(1),
    prevTab: () => cycleTab(-1),
    back: () => send(nav({ type: 'back' })),
    forward: () => send(nav({ type: 'forward' })),
    reload: () => send({ type: 'reload' }),
    sidebar: () => setSidebar(!state.sidebarVisible, null, true),
    files: () => showPane('files', true),
    search: () => showPane('search', true),
    toc: () => showPane('toc', false),
    backlinks: () => showPane('backlinks', false),
    find: () => openFind(false),
    findNext: () => gotoHit(find.index + 1, true),
    findPrev: () => gotoHit(find.index - 1, true),
    findClose: closeFind,
    zoomIn: () => setZoom(state.zoom + 0.1),
    zoomOut: () => setZoom(state.zoom - 0.1),
    zoomReset: () => setZoom(1),
    theme: () => setTheme(isDark() ? 'light' : 'dark', true),
    print: () => window.print(),
    switcher: openSwitcher,
    togglePreview: () => {
      state.hoverPreview = !state.hoverPreview; syncMenuChecks();
      if (!state.hoverPreview) hidePreview(true);
      send({ type: 'setting', key: 'hoverPreview', value: state.hoverPreview });
    },
    menu: () => { $('#menu').hidden = !$('#menu').hidden; },
    showInFolder: () => send({ type: 'showInFolder' }),
    openInObsidian: () => send({ type: 'openInObsidian' }),
    registerOpenWith: () => send({ type: 'registerOpenWith' }),
    toggleSnippets: () => {
      state.cssSnippets = !state.cssSnippets; syncMenuChecks();
      send({ type: 'setting', key: 'cssSnippets', value: state.cssSnippets });
    },
    toggleRestore: () => {
      state.restoreSession = !state.restoreSession; syncMenuChecks();
      send({ type: 'setting', key: 'restoreSession', value: state.restoreSession });
    }
  };

  document.addEventListener('click', (e) => {
    const cmdEl = e.target.closest('[data-cmd]');
    if (cmdEl) {
      e.preventDefault();
      if (cmdEl.dataset.cmd !== 'menu') $('#menu').hidden = true;
      const fn = commands[cmdEl.dataset.cmd];
      if (fn) fn();
      return;
    }
    if (!e.target.closest('.tb-menu-wrap')) $('#menu').hidden = true;

    const tocA = e.target.closest('#toc-list a[data-target]');
    if (tocA) {
      e.preventDefault();
      const h = document.getElementById(tocA.dataset.target);
      if (h) h.scrollIntoView({ block: 'start' });
      return;
    }

    const recentA = e.target.closest('#recent-list a[data-path]');
    if (recentA) { e.preventDefault(); send(nav({ type: 'openPath', path: recentA.dataset.path, newTab: e.ctrlKey })); return; }

    const a = e.target.closest('#doc a, #preview a');
    if (a) {
      const inPreview = !!a.closest('#preview');
      handleDocLink(a, e, e.ctrlKey || e.metaKey);
      if (inPreview) hidePreview(true);
    }
  });

  // 가운데 버튼 클릭 → 새 탭
  document.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const a = e.target.closest('#doc a');
    if (a) handleDocLink(a, e, true);
  });

  function handleDocLink(a, e, newTab) {
    if (a.classList.contains('tag')) { e.preventDefault(); searchTag(a.dataset.tag); return; }

    const wl = a.getAttribute('data-href');
    if (wl != null) {
      e.preventDefault();
      if (wl.startsWith('#') && !newTab) { scrollToAnchor(wl.slice(1)); return; }
      const host = a.closest('.embed-note, #preview');
      if (wl.startsWith('#') && host && host.id === 'preview' && host.dataset.from === state.doc.path) { scrollToAnchor(wl.slice(1)); return; }
      send(nav({ type: 'navigate', target: wl, from: (host && host.dataset.from) || state.doc.path, newTab }));
      return;
    }

    const href = a.getAttribute('href');
    if (!href) return;
    e.preventDefault();
    if (href.startsWith('#')) {
      const id = safeDecode(href.slice(1));
      const target = document.getElementById(id);
      if (target) target.scrollIntoView({ block: 'start' });
      else scrollToAnchor(id);
      return;
    }
    if (/^(https?:|mailto:|obsidian:)/i.test(href)) { send({ type: 'external', url: href }); return; }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href)) return; // 알 수 없는 스킴은 무시
    const hostNote = a.closest('.embed-note, #preview');
    send(nav({ type: 'navigateHref', href, from: (hostNote && hostNote.dataset.from) || state.doc.path, newTab }));
  }

  document.addEventListener('mouseover', (e) => {
    const a = e.target.closest('a.internal-link, a.external-link');
    if (!a || a.title) return;
    if (state.hoverPreview && a.classList.contains('internal-link') && a.closest('#doc')) return; // 미리보기와 겹치지 않게
    a.title = a.getAttribute('data-href') || a.getAttribute('href') || '';
  });

  document.addEventListener('mouseup', (e) => {
    if (e.button === 3) { e.preventDefault(); commands.back(); }
    if (e.button === 4) { e.preventDefault(); commands.forward(); }
  });

  document.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(state.zoom + (e.deltaY < 0 ? 0.1 : -0.1));
  }, { passive: false });

  document.addEventListener('keydown', (e) => {
    const k = e.key;
    const lk = k.length === 1 ? k.toLowerCase() : k;
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    const inInput = e.target.tagName === 'INPUT';
    if (inInput && e.target.id === 'find-input') {
      if (k === 'Enter') { e.preventDefault(); shift ? commands.findPrev() : commands.findNext(); return; }
      if (k === 'Escape') { e.preventDefault(); closeFind(); return; }
    }
    let fn = null;
    if (!$('#switcher').hidden) return; // 빠른 이동 창이 키 입력을 처리
    if (ctrl && shift && lk === 'p') fn = commands.print;
    else if (ctrl && lk === 'p') fn = commands.switcher;
    else if (ctrl && shift && lk === 't') fn = commands.reopenTab;
    else if (ctrl && shift && lk === 'e') fn = commands.files;
    else if (ctrl && shift && lk === 'f') fn = commands.search;
    else if (ctrl && shift && lk === 'o') fn = commands.toc;
    else if (ctrl && shift && lk === 'b') fn = commands.backlinks;
    else if (ctrl && k === 'Tab') fn = shift ? commands.prevTab : commands.nextTab;
    else if (ctrl && k === 'PageDown') fn = commands.nextTab;
    else if (ctrl && k === 'PageUp') fn = commands.prevTab;
    else if (ctrl && /^[1-9]$/.test(k)) { e.preventDefault(); gotoTabIndex(+k); return; }
    else if (ctrl && lk === 't') fn = commands.newTab;
    else if (ctrl && (lk === 'w' || k === 'F4')) fn = commands.closeTab;
    else if (ctrl && lk === 'o') fn = commands.open;
    else if (ctrl && lk === 'f') fn = commands.find;
    else if (ctrl && lk === 'd') fn = commands.theme;
    else if (ctrl && k === '\\') fn = commands.sidebar;
    else if (ctrl && (k === '=' || k === '+')) fn = commands.zoomIn;
    else if (ctrl && k === '-') fn = commands.zoomOut;
    else if (ctrl && k === '0') fn = commands.zoomReset;
    else if (k === 'F5' || (ctrl && lk === 'r')) fn = commands.reload;
    else if (k === 'F3') fn = shift ? commands.findPrev : commands.findNext;
    else if (e.altKey && k === 'ArrowLeft') fn = commands.back;
    else if (e.altKey && k === 'ArrowRight') fn = commands.forward;
    else if (k === 'Backspace' && !inInput) fn = commands.back;
    else if (k === 'Escape' && !previewEl.hidden) fn = () => hidePreview(true);
    else if (k === 'Escape' && !$('#findbar').hidden) fn = closeFind;
    else if (!inInput && (k === 'Home' || k === 'End')) {
      e.preventDefault();
      mainEl.scrollTop = k === 'Home' ? 0 : mainEl.scrollHeight;
      return;
    }
    if (fn) { e.preventDefault(); fn(); }
  });

  let findTimer = null;
  $('#find-input').addEventListener('input', () => {
    clearTimeout(findTimer);
    findTimer = setTimeout(() => runFind(true), 150);
  });

  // ───────────── 끌어다 놓기 ─────────────
  let dragDepth = 0;
  const overlay = $('#drop-overlay');
  document.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer.types || [])].includes('Files')) return;
    dragDepth++; overlay.hidden = false;
  });
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; overlay.hidden = true; } });
  document.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0; overlay.hidden = true;
    const files = e.dataTransfer.files;
    if (files && files.length && webview && webview.postMessageWithAdditionalObjects) {
      webview.postMessageWithAdditionalObjects('drop', files);
    }
  });

  // ───────────── 호스트 메시지 ─────────────
  function handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'settings':
        state.zoom = msg.zoom || 1;
        state.sidebarWidth = msg.sidebarWidth || 260;
        state.cssSnippets = msg.cssSnippets !== false;
        state.restoreSession = msg.restoreSession !== false;
        state.hoverPreview = msg.hoverPreview !== false;
        applyZoom();
        applySidebarWidth();
        syncMenuChecks();
        setTheme(msg.theme || 'system', false);
        setSidebar(msg.sidebarVisible !== false, msg.sidebarPane || 'files', false);
        break;
      case 'tabs': renderTabs(msg); break;
      case 'load': renderDoc(msg); break;
      case 'welcome': showWelcome(msg); break;
      case 'index':
        setIndex(msg.vaultKey, msg.notes);
        if (state.doc && state.doc.vaultKey === msg.vaultKey) renderFiles(false);
        break;
      case 'resolved': onResolved(msg); break;
      case 'scrollTo': scrollToAnchor(msg.anchor); break;
      case 'backlinks': onBacklinks(msg); break;
      case 'searchResults': onSearchResults(msg); break;
      case 'toast': toast(msg.text); break;
      case 'error': toast('⚠ ' + msg.text); break;
    }
  }

  if (webview) webview.addEventListener('message', (e) => handle(e.data));
  window.__mdreader = { handle, renderer }; // 테스트/디버그용

  applyTheme();
  applySidebarWidth();
  setSidebar(true, 'files', false);
  send({ type: 'ready' });
})();
