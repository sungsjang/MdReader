/*
 * MdReader — Obsidian 확장 문법 렌더러
 * markdown-it 위에 Obsidian 문법(위키링크, 임베드, 콜아웃, 하이라이트, 주석, 태그,
 * 블록 ID, 작업 목록, 각주, 수식, Mermaid, 프론트매터)을 얹는다.
 * 전역: window.ObsidianMarkdown.create({ katex, hljs, yaml })
 */
(function (global) {
  'use strict';

  const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'avif', 'ico'];
  const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'ogg', 'flac', '3gp'];
  const VIDEO_EXT = ['mp4', 'webm', 'ogv', 'mov', 'mkv'];

  // Obsidian 콜아웃 별칭 → 기본 유형
  const CALLOUT_ALIAS = {
    summary: 'abstract', tldr: 'abstract',
    hint: 'tip', important: 'tip',
    check: 'success', done: 'success',
    help: 'question', faq: 'question',
    caution: 'warning', attention: 'warning',
    fail: 'failure', missing: 'failure',
    error: 'danger',
    cite: 'quote'
  };

  const ICON_PATHS = {
    note: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    abstract: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6M9 16h6"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    todo: '<circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/>',
    tip: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.1-.2-4 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.3 1-3.1.6 1.3 1.6 2.6 2.5 2.6z"/>',
    success: '<path d="M20 6L9 17l-5-5"/>',
    question: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
    warning: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    failure: '<path d="M18 6L6 18M6 6l12 12"/>',
    danger: '<path d="M13 2L3 14h9l-1 8 10-12h-9z"/>',
    bug: '<rect x="8" y="6" width="8" height="14" rx="4"/><path d="M19 7l-3 2M5 7l3 2M19 19l-3-2M5 19l3-2M20 13h-4M4 13h4M10 4l1 2M14 4l-1 2"/>',
    example: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    quote: '<path d="M3 21c3 0 7-1 7-8V5H3v7h4c0 3-2 5-4 5zM14 21c3 0 7-1 7-8V5h-7v7h4c0 3-2 5-4 5z"/>'
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function extOf(target) {
    const file = String(target).split('#')[0];
    const m = /\.([A-Za-z0-9]+)$/.exec(file);
    return m ? m[1].toLowerCase() : '';
  }

  function embedKind(target) {
    const ext = extOf(target);
    if (IMAGE_EXT.includes(ext)) return 'image';
    if (AUDIO_EXT.includes(ext)) return 'audio';
    if (VIDEO_EXT.includes(ext)) return 'video';
    if (ext === 'pdf') return 'pdf';
    if (ext === '' || ext === 'md') return 'note';
    // "Note v1.2" 처럼 점이 들어간 노트 이름도 노트로 취급
    if (!/^[a-z0-9]{1,5}$/.test(ext) || /^\d+$/.test(ext)) return 'note';
    return 'file';
  }

  function normHeading(s) {
    return String(s).replace(/[*_`~=\[\]]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function calloutIcon(type) {
    const p = ICON_PATHS[type] || ICON_PATHS.note;
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + p + '</svg>';
  }

  // ───────────────────────── 전처리 ─────────────────────────
  // 코드 블록을 건드리지 않도록 소스를 [코드, 일반] 조각으로 나눈다.
  function splitByFences(src) {
    const lines = src.split('\n');
    const chunks = [];
    let buf = [];
    let inFence = false;
    let fenceChar = '';
    let fenceLen = 0;
    const flush = (code) => {
      if (buf.length) chunks.push({ code, text: buf.join('\n') });
      buf = [];
    };
    for (const line of lines) {
      const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (!inFence && m) {
        flush(false);
        inFence = true; fenceChar = m[1][0]; fenceLen = m[1].length;
        buf.push(line);
      } else if (inFence && m && m[1][0] === fenceChar && m[1].length >= fenceLen &&
                 line.trim().replace(new RegExp('\\' + fenceChar, 'g'), '') === '') {
        buf.push(line);
        flush(true);
        inFence = false;
      } else {
        buf.push(line);
      }
    }
    flush(inFence);
    return chunks;
  }

  function preprocess(src, yaml) {
    src = String(src || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');

    // 1) 프론트매터
    let frontmatter = null;
    let frontmatterRaw = null;
    const fm = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(src);
    if (fm) {
      frontmatterRaw = fm[1];
      try {
        const load = yaml && (yaml.safeLoad || yaml.load);
        frontmatter = load ? load(fm[1]) : null;
      } catch (e) {
        frontmatter = { '⚠ YAML 오류': String(e.message || e).split('\n')[0] };
      }
      if (frontmatter !== null && typeof frontmatter !== 'object') frontmatter = { value: frontmatter };
      src = src.slice(fm[0].length);
    }

    // 2) %%주석%% 제거 + 3) 각주 정의 수집 (코드 블록 밖에서만)
    const footnotes = Object.create(null);
    const chunks = splitByFences(src).map((ch) => {
      if (ch.code) return ch.text;
      let text = ch.text.replace(/%%[\s\S]*?%%/g, '');
      const out = [];
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const m = /^\[\^([^\]\s]+)\]:[ \t]?(.*)$/.exec(lines[i]);
        if (!m) { out.push(lines[i]); continue; }
        const body = [m[2]];
        while (i + 1 < lines.length && /^( {2,}|\t)\S/.test(lines[i + 1])) {
          body.push(lines[++i].replace(/^( {1,4}|\t)/, ''));
        }
        footnotes[m[1]] = body.join('\n');
      }
      return out.join('\n');
    });

    return { body: chunks.join('\n'), frontmatter, frontmatterRaw, footnotes };
  }

  // ───────────────────────── markdown-it 플러그인 ─────────────────────────
  function obsidianPlugin(md, deps) {
    const katex = deps.katex;

    // [[위키링크]] / ![[임베드]]
    md.inline.ruler.before('link', 'ob_wikilink', function (state, silent) {
      const src = state.src;
      let pos = state.pos;
      let embed = false;
      if (src.charCodeAt(pos) === 0x21 /* ! */) {
        if (src.charCodeAt(pos + 1) !== 0x5B || src.charCodeAt(pos + 2) !== 0x5B) return false;
        embed = true; pos += 1;
      } else if (src.charCodeAt(pos) !== 0x5B || src.charCodeAt(pos + 1) !== 0x5B) {
        return false;
      }
      const end = src.indexOf(']]', pos + 2);
      if (end < 0) return false;
      const inner = src.slice(pos + 2, end);
      if (!inner.trim() || inner.indexOf('\n') >= 0 || inner.indexOf('[[') >= 0) return false;
      if (!silent) {
        const bar = inner.indexOf('|');
        let target = bar >= 0 ? inner.slice(0, bar) : inner;
        const alias = bar >= 0 ? inner.slice(bar + 1).trim() : '';
        target = target.replace(/\\$/, '').trim(); // 표 안의 [[a\|b]]
        const tok = state.push(embed ? 'ob_embed' : 'ob_wikilink', '', 0);
        tok.meta = { target, alias };
      }
      state.pos = end + 2;
      return true;
    });

    // [^각주] 참조
    md.inline.ruler.before('link', 'ob_footnote_ref', function (state, silent) {
      const src = state.src, pos = state.pos;
      if (src.charCodeAt(pos) !== 0x5B || src.charCodeAt(pos + 1) !== 0x5E) return false;
      const end = src.indexOf(']', pos + 2);
      if (end < 0) return false;
      const id = src.slice(pos + 2, end);
      if (!id || /\s/.test(id)) return false;
      const fn = state.env.__fn;
      if (!fn || !(id in fn.defs)) return false;
      if (!silent) {
        const tok = state.push('ob_footnote_ref', '', 0);
        tok.meta = { id };
      }
      state.pos = end + 1;
      return true;
    });

    // ^[인라인 각주]
    md.inline.ruler.before('link', 'ob_inline_footnote', function (state, silent) {
      const src = state.src, pos = state.pos;
      if (src.charCodeAt(pos) !== 0x5E || src.charCodeAt(pos + 1) !== 0x5B) return false;
      let depth = 1, i = pos + 2;
      for (; i < state.posMax; i++) {
        const c = src[i];
        if (c === '[') depth++;
        else if (c === ']' && --depth === 0) break;
      }
      if (depth !== 0) return false;
      if (!silent) {
        const fn = state.env.__fn;
        if (!fn) return false;
        const id = '__inline' + (++fn.inlineCount);
        fn.defs[id] = src.slice(pos + 2, i);
        const tok = state.push('ob_footnote_ref', '', 0);
        tok.meta = { id };
      }
      state.pos = i + 1;
      return true;
    });

    // ==하이라이트==
    md.inline.ruler.before('emphasis', 'ob_mark', function (state, silent) {
      const src = state.src, pos = state.pos;
      if (src.charCodeAt(pos) !== 0x3D || src.charCodeAt(pos + 1) !== 0x3D) return false;
      const start = pos + 2;
      const c = src[start];
      if (!c || c === ' ' || c === '=' || c === '\n') return false;
      const end = src.indexOf('==', start);
      if (end < 0 || end >= state.posMax || /\s/.test(src[end - 1])) return false;
      if (!silent) {
        state.push('mark_open', 'mark', 1);
        const oldMax = state.posMax;
        state.pos = start;
        state.posMax = end;
        state.md.inline.tokenize(state);
        state.posMax = oldMax;
        state.push('mark_close', 'mark', -1);
      }
      state.pos = end + 2;
      return true;
    });

    // $인라인 수식$ / $$한 줄 수식$$
    md.inline.ruler.after('escape', 'ob_math_inline', function (state, silent) {
      const src = state.src, pos = state.pos;
      if (src.charCodeAt(pos) !== 0x24) return false;
      if (src.charCodeAt(pos + 1) === 0x24) {
        const end = src.indexOf('$$', pos + 2);
        if (end < 0 || end + 2 > state.posMax || end === pos + 2) return false;
        if (!silent) {
          const t = state.push('math_inline', 'math', 0);
          t.content = src.slice(pos + 2, end); t.meta = { display: true };
        }
        state.pos = end + 2;
        return true;
      }
      const start = pos + 1;
      if (!src[start] || /\s/.test(src[start])) return false;
      let end = start;
      for (;;) {
        end = src.indexOf('$', end);
        if (end < 0 || end >= state.posMax) return false;
        if (src[end - 1] === '\\') { end++; continue; }
        break;
      }
      if (end === start || /\s/.test(src[end - 1]) || /\d/.test(src[end + 1] || '')) return false;
      if (!silent) {
        const t = state.push('math_inline', 'math', 0);
        t.content = src.slice(start, end); t.meta = { display: false };
      }
      state.pos = end + 1;
      return true;
    });

    // #태그
    const TAG_RE = /^#([\p{L}\p{N}\p{M}_\-\/]+)/u;
    md.inline.ruler.before('emphasis', 'ob_tag', function (state, silent) {
      const src = state.src, pos = state.pos;
      if (src.charCodeAt(pos) !== 0x23) return false;
      if (pos > 0 && !/[\s(]/.test(src[pos - 1])) return false;
      const m = TAG_RE.exec(src.slice(pos, state.posMax));
      if (!m || !/[^\d\/]/.test(m[1])) return false;
      if (!silent) {
        const t = state.push('ob_tag', '', 0);
        t.content = m[1].replace(/\/+$/, '');
      }
      state.pos = pos + m[0].length;
      return true;
    });

    // $$ 블록 수식 $$
    md.block.ruler.before('fence', 'ob_math_block', function (state, startLine, endLine, silent) {
      if (state.sCount[startLine] - state.blkIndent >= 4) return false;
      const pos = state.bMarks[startLine] + state.tShift[startLine];
      const max = state.eMarks[startLine];
      if (state.src.slice(pos, pos + 2) !== '$$') return false;
      const first = state.src.slice(pos + 2, max);
      let line = startLine;
      let content;
      const ft = first.trim();
      if (ft.length >= 2 && ft.endsWith('$$')) {
        content = ft.slice(0, -2);
      } else {
        const parts = [first];
        let found = false;
        for (line = startLine + 1; line < endLine; line++) {
          const p = state.bMarks[line] + state.tShift[line];
          const l = state.src.slice(p, state.eMarks[line]);
          if (state.sCount[line] < state.blkIndent) break;
          const lt = l.trimEnd();
          if (lt.endsWith('$$')) { parts.push(lt.slice(0, -2)); found = true; break; }
          parts.push(l);
        }
        if (!found) return false;
        content = parts.join('\n');
      }
      if (silent) return true;
      state.line = line + 1;
      const t = state.push('math_block', 'math', 0);
      t.block = true; t.content = content; t.map = [startLine, state.line];
      return true;
    }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

    // > [!콜아웃]
    md.core.ruler.before('inline', 'ob_callout', function (state) {
      const tokens = state.tokens;
      const stack = [];
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type === 'blockquote_open') {
          stack.push(t);
          const p = tokens[i + 1], inl = tokens[i + 2];
          if (p && p.type === 'paragraph_open' && inl && inl.type === 'inline') {
            const m = /^\[!([^\]\s]+)\]([+-]?)[ \t]*(.*)(?:\n|$)/.exec(inl.content);
            if (m) {
              t.meta = { callout: { type: m[1].toLowerCase(), fold: m[2], title: m[3].trim() } };
              inl.content = inl.content.slice(m[0].length);
              if (!inl.content.trim()) tokens.splice(i + 1, 3);
            }
          }
        } else if (t.type === 'blockquote_close') {
          const open = stack.pop();
          if (open && open.meta && open.meta.callout) t.meta = { callout: open.meta.callout };
        }
      }
    });

    // 작업 목록, 블록 ID, 제목 앵커
    md.core.ruler.after('inline', 'ob_post', function (state) {
      const t = state.tokens;
      const used = state.env.__headingIds || (state.env.__headingIds = Object.create(null));
      for (let i = 0; i < t.length; i++) {
        const tok = t[i];

        if (tok.type === 'heading_open' && t[i + 1] && t[i + 1].type === 'inline') {
          const text = t[i + 1].content;
          let base = 'h-' + normHeading(text).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
          if (base === 'h-') base = 'h-section';
          let id = base, n = 1;
          while (used[id]) id = base + '-' + (++n);
          used[id] = true;
          tok.attrSet('id', id);
          tok.attrSet('data-heading', normHeading(text.replace(/\s\^[A-Za-z0-9-]+\s*$/, '')));
        }

        if (tok.type !== 'inline' || !tok.children || !tok.children.length) continue;
        const kids = tok.children;

        // 블록 ID:  문단 끝의 ^abc123
        const last = kids[kids.length - 1];
        if (last.type === 'text') {
          const onlyId = kids.length === 1 && /^\^([A-Za-z0-9-]+)$/.exec(last.content.trim());
          const m = onlyId || /\s\^([A-Za-z0-9-]+)\s*$/.exec(last.content);
          if (m) {
            const open = t[i - 1];
            if (onlyId) {
              last.content = '';
              if (open && open.type === 'paragraph_open') {
                open.attrSet('id', '^' + m[1]);
                open.attrJoin('class', 'block-anchor');
              }
            } else {
              last.content = last.content.slice(0, m.index);
              let target = open;
              if (open && open.type === 'paragraph_open' && open.hidden && t[i - 2] && t[i - 2].type === 'list_item_open') target = t[i - 2];
              if (target && /_open$/.test(target.type)) target.attrSet('id', '^' + m[1]);
            }
          }
        }

        // 작업 목록: - [ ] / - [x] / - [-] ...
        if (i >= 2 && t[i - 1].type === 'paragraph_open' && t[i - 2].type === 'list_item_open') {
          const first = kids[0];
          if (first && first.type === 'text') {
            const m = /^\[(.)\](?:[ \t]+|$)/.exec(first.content);
            if (m) {
              first.content = first.content.slice(m[0].length);
              const ch = m[1];
              const li = t[i - 2];
              li.attrJoin('class', 'task-list-item');
              if (ch !== ' ') { li.attrJoin('class', 'is-checked'); li.attrSet('data-task', ch); }
              const cb = new state.Token('html_inline', '', 0);
              cb.content = '<input type="checkbox" class="task-checkbox" disabled' + (ch !== ' ' ? ' checked' : '') + '>';
              kids.unshift(cb);
              for (let j = i - 3; j >= 0; j--) {
                if ((t[j].type === 'bullet_list_open' || t[j].type === 'ordered_list_open') && t[j].level === li.level - 1) {
                  t[j].attrJoin('class', 'contains-task-list');
                  break;
                }
              }
            }
          }
        }
      }
    });

    // ── 렌더러 ──
    const R = md.renderer.rules;

    R.ob_wikilink = function (tokens, idx, opts, env) {
      const { target, alias } = tokens[idx].meta;
      const hash = target.indexOf('#');
      const file = hash >= 0 ? target.slice(0, hash) : target;
      const sub = hash >= 0 ? target.slice(hash + 1) : '';
      let text = alias;
      if (!text) {
        const name = file.replace(/\.md$/i, '');
        const subText = sub.replace(/^\^/, '^').split('#').filter(Boolean).join(' > ');
        text = name && subText ? name + ' > ' + subText : (name || subText);
      }
      const resolved = !file || !env.isResolved || env.isResolved(file);
      return '<a class="internal-link' + (resolved ? '' : ' is-unresolved') + '" href="#" data-href="' +
        esc(target) + '">' + esc(text) + '</a>';
    };

    R.ob_embed = function (tokens, idx) {
      const { target, alias } = tokens[idx].meta;
      const kind = embedKind(target);
      let w = '', h = '';
      if (alias && /^\d+(x\d+)?$/.test(alias)) [w, h] = alias.split('x');
      if (kind === 'image') {
        return '<img class="embed-image" data-embed="' + esc(target) + '" alt="' +
          esc(alias && !w ? alias : target.split('/').pop()) + '"' +
          (w ? ' width="' + w + '"' : '') + (h ? ' height="' + h + '"' : '') + '>';
      }
      return '<span class="embed-placeholder" data-embed="' + esc(target) + '" data-kind="' + kind +
        '" data-alias="' + esc(alias) + '"' + (w ? ' data-width="' + w + '"' : '') + '></span>';
    };

    R.ob_tag = function (tokens, idx) {
      const tag = tokens[idx].content;
      return '<a class="tag" href="#" data-tag="' + esc(tag) + '">#' + esc(tag) + '</a>';
    };

    R.ob_footnote_ref = function (tokens, idx, opts, env) {
      const fn = env.__fn;
      const id = tokens[idx].meta.id;
      let n = fn.order.indexOf(id);
      if (n < 0) { fn.order.push(id); n = fn.order.length - 1; }
      fn.refCount[id] = (fn.refCount[id] || 0) + 1;
      const refId = 'fnref-' + (n + 1) + (fn.refCount[id] > 1 ? '-' + fn.refCount[id] : '');
      return '<sup class="footnote-ref"><a href="#fn-' + (n + 1) + '" id="' + refId + '">' + (n + 1) + '</a></sup>';
    };

    function renderMath(content, display) {
      if (!katex) return '<code class="math-fallback">' + esc(content) + '</code>';
      try {
        return katex.renderToString(content, { displayMode: display, throwOnError: false, strict: 'ignore', trust: false });
      } catch (e) {
        return '<code class="math-error" title="' + esc(e.message) + '">' + esc(content) + '</code>';
      }
    }
    R.math_inline = (tokens, idx) => renderMath(tokens[idx].content, tokens[idx].meta.display);
    R.math_block = (tokens, idx) => '<div class="math-block">' + renderMath(tokens[idx].content, true) + '</div>\n';

    R.blockquote_open = function (tokens, idx, opts, env, self) {
      const c = tokens[idx].meta && tokens[idx].meta.callout;
      if (!c) return self.renderToken(tokens, idx, opts);
      const type = CALLOUT_ALIAS[c.type] || c.type;
      const title = c.title ? md.renderInline(c.title, env)
        : esc(c.type.charAt(0).toUpperCase() + c.type.slice(1).replace(/-/g, ' '));
      const head = '<div class="callout-title"><span class="callout-icon">' + calloutIcon(type) +
        '</span><span class="callout-title-inner">' + title + '</span>' +
        (c.fold ? '<span class="callout-fold" aria-hidden="true"></span>' : '') + '</div>';
      const attrs = ' class="callout" data-callout="' + esc(type) + '"';
      if (c.fold) {
        return '<details' + attrs + (c.fold === '+' ? ' open' : '') + '><summary>' + head +
          '</summary><div class="callout-content">\n';
      }
      return '<div' + attrs + '>' + head + '<div class="callout-content">\n';
    };
    R.blockquote_close = function (tokens, idx, opts, env, self) {
      const c = tokens[idx].meta && tokens[idx].meta.callout;
      if (!c) return self.renderToken(tokens, idx, opts);
      return c.fold ? '</div></details>\n' : '</div></div>\n';
    };

    const defaultFence = R.fence;
    R.fence = function (tokens, idx, opts, env, self) {
      const tok = tokens[idx];
      const lang = (tok.info || '').trim().split(/\s+/)[0].toLowerCase();
      if (lang === 'mermaid') {
        return '<div class="mermaid-block"><pre class="mermaid" data-source="' + esc(tok.content) + '">' +
          esc(tok.content) + '</pre></div>\n';
      }
      if (/^(dataview|dataviewjs|tasks|query|button|meta-bind.*)$/.test(lang)) {
        return '<div class="plugin-block"><div class="plugin-block-label">' + esc(lang) +
          ' · 플러그인 블록 — 뷰어에서는 실행되지 않습니다</div>' + defaultFence(tokens, idx, opts, env, self) + '</div>\n';
      }
      const html = defaultFence(tokens, idx, opts, env, self);
      return lang ? html.replace('<pre>', '<pre data-lang="' + esc(lang) + '">') : html;
    };

    // 표는 가로 스크롤 래퍼로 감싼다
    R.table_open = () => '<div class="table-wrap"><table>\n';
    R.table_close = () => '</table></div>\n';
  }

  // ───────────────────────── 프론트매터(속성) 렌더링 ─────────────────────────
  function renderProperties(md, fm, env) {
    if (!fm || typeof fm !== 'object' || !Object.keys(fm).length) return '';
    const val = (key, v) => {
      if (v == null || v === '') return '<span class="prop-empty">—</span>';
      if (Array.isArray(v)) {
        return v.map((x) => {
          if (/^(tags?|aliases|cssclasses)$/i.test(key) && typeof x === 'string') {
            return /^tags?$/i.test(key)
              ? '<a class="tag" href="#" data-tag="' + esc(x.replace(/^#/, '')) + '">#' + esc(x.replace(/^#/, '')) + '</a>'
              : '<span class="prop-chip">' + esc(x) + '</span>';
          }
          return '<span class="prop-chip">' + val('', x) + '</span>';
        }).join(' ');
      }
      if (v instanceof Date) return esc(v.toISOString().slice(0, 10));
      if (typeof v === 'object') return '<code>' + esc(JSON.stringify(v)) + '</code>';
      if (typeof v === 'boolean') return '<input type="checkbox" disabled' + (v ? ' checked' : '') + '>';
      const s = String(v);
      if (/^tags?$/i.test(key)) {
        return s.split(/[,\s]+/).filter(Boolean).map((x) =>
          '<a class="tag" href="#" data-tag="' + esc(x.replace(/^#/, '')) + '">#' + esc(x.replace(/^#/, '')) + '</a>').join(' ');
      }
      return md.renderInline(s, env);
    };
    let rows = '';
    for (const k of Object.keys(fm)) {
      rows += '<tr><th>' + esc(k) + '</th><td>' + val(k, fm[k]) + '</td></tr>';
    }
    return '<details class="properties" open><summary>속성</summary><table>' + rows + '</table></details>\n';
  }

  // ───────────────────────── 임베드용 구간 추출 ─────────────────────────
  // ![[노트#제목]] → 해당 제목 섹션만, ![[노트#^id]] → 해당 블록만
  function extractSection(markdown, sub) {
    if (!sub) return markdown;
    const pre = preprocess(markdown, null).body;
    const lines = pre.split('\n');
    if (sub.startsWith('^')) {
      const id = sub.slice(1);
      const re = new RegExp('(^|\\s)\\^' + id.replace(/[-]/g, '\\-') + '\\s*$');
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        if (/^\s*\^[A-Za-z0-9-]+\s*$/.test(lines[i])) {
          // 단독 줄의 블록 ID → 바로 위 블록(빈 줄 전까지)
          let s = i - 1;
          while (s > 0 && lines[s - 1].trim() !== '') s--;
          return lines.slice(s, i).join('\n');
        }
        // 문단(또는 목록 항목) 단위
        let s = i, e = i;
        if (!/^\s*([-*+]|\d+\.)\s/.test(lines[i])) {
          while (s > 0 && lines[s - 1].trim() !== '' && !/^#{1,6}\s/.test(lines[s - 1])) s--;
        }
        return lines.slice(s, e + 1).join('\n');
      }
      return null;
    }
    const want = normHeading(sub.split('#').pop());
    let start = -1, level = 0, inFence = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^ {0,3}(```|~~~)/.test(lines[i])) inFence = !inFence;
      if (inFence) continue;
      const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
      if (!m) continue;
      if (start < 0) {
        if (normHeading(m[2]) === want) { start = i; level = m[1].length; }
      } else if (m[1].length <= level) {
        return lines.slice(start, i).join('\n');
      }
    }
    return start >= 0 ? lines.slice(start).join('\n') : null;
  }

  // ───────────────────────── 공개 API ─────────────────────────
  function create(deps) {
    deps = deps || {};
    const md = global.markdownit({
      html: true,
      linkify: true,
      typographer: false,
      breaks: false,
      highlight: function (str, lang) {
        const hljs = deps.hljs;
        if (hljs && lang && hljs.getLanguage(lang)) {
          try {
            return '<pre class="hljs"><code>' + hljs.highlight(str, { language: lang, ignoreIllegals: true }).value + '</code></pre>';
          } catch (e) { /* 무시 */ }
        }
        return '';
      }
    });
    md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });
    obsidianPlugin(md, deps);

    /**
     * @param {string} source  원본 마크다운
     * @param {object} opts    { isResolved(name), showProperties }
     * @returns {{html:string, frontmatter:object|null, title:string|null}}
     */
    function render(source, opts) {
      opts = opts || {};
      const pre = preprocess(source, deps.yaml);
      const env = {
        isResolved: opts.isResolved,
        __fn: { defs: pre.footnotes, order: [], refCount: {}, inlineCount: 0 },
        __headingIds: opts.headingIds || Object.create(null)
      };
      let html = md.render(pre.body, env);

      if (env.__fn.order.length) {
        let items = '';
        env.__fn.order.forEach((id, i) => {
          const n = i + 1;
          const body = md.render(env.__fn.defs[id], env).trim();
          const back = ' <a href="#fnref-' + n + '" class="footnote-backref">↩</a>';
          const withBack = /<\/p>$/.test(body) ? body.replace(/<\/p>$/, back + '</p>') : body + back;
          items += '<li id="fn-' + n + '" class="footnote-item">' + withBack + '</li>';
        });
        html += '<section class="footnotes"><hr><ol>' + items + '</ol></section>\n';
      }

      const props = opts.showProperties === false ? '' : renderProperties(md, pre.frontmatter, env);
      let title = null;
      if (pre.frontmatter && typeof pre.frontmatter.title === 'string') title = pre.frontmatter.title;
      return { html: props + html, frontmatter: pre.frontmatter, title };
    }

    return { md, render, extractSection, embedKind, normHeading, esc };
  }

  global.ObsidianMarkdown = { create, preprocess, extractSection, embedKind, normHeading };
})(typeof window !== 'undefined' ? window : globalThis);
