/*
 * MdReader — 편집 모드 (CodeMirror 6)
 * vendor/editor.js 가 window.CM 에 CodeMirror 모듈을 올려 두고, 여기서 편집기를 구성한다.
 * 전역: window.MdEditor.create(parent, options)
 */
(function () {
  'use strict';

  const KO_PHRASES = {
    'Find': '찾기', 'Replace': '바꿀 내용', 'next': '다음', 'previous': '이전', 'all': '모두',
    'match case': '대소문자 구분', 'regexp': '정규식', 'by word': '단어 단위',
    'replace': '바꾸기', 'replace all': '모두 바꾸기', 'close': '닫기',
    'current match': '현재 항목', 'on line': '줄', 'Go to line': '줄로 이동', 'go': '이동'
  };

  // 문서 맨 앞의 YAML 프론트매터(---)를 하나의 블록으로 인식시킨다.
  // (없으면 'tags: …' 줄과 '---' 가 큰 제목(setext)으로 잘못 칠해진다)
  const Frontmatter = {
    defineNodes: [{ name: 'Frontmatter', block: true }],
    parseBlock: [{
      name: 'Frontmatter',
      before: 'HorizontalRule',
      parse(cx, line) {
        if (cx.lineStart !== 0 || !/^---\s*$/.test(line.text)) return false;
        const start = cx.lineStart;
        let end = start + line.text.length;
        while (cx.nextLine()) {
          end = cx.lineStart + line.text.length;
          if (/^(---|\.\.\.)\s*$/.test(line.text)) { cx.nextLine(); break; }
        }
        cx.addElement(cx.elt('Frontmatter', start, end));
        return true;
      }
    }]
  };

  function create(parent, opts) {
    const CM = window.CM;
    if (!CM) throw new Error('편집기 라이브러리(vendor/editor.js)를 불러오지 못했습니다.');
    const t = CM.tags;

    const highlight = CM.HighlightStyle.define([
      { tag: t.heading1, fontSize: '1.5em', fontWeight: '700' },
      { tag: t.heading2, fontSize: '1.3em', fontWeight: '700' },
      { tag: t.heading3, fontSize: '1.15em', fontWeight: '700' },
      { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '700' },
      { tag: t.strong, fontWeight: '700' },
      { tag: t.emphasis, fontStyle: 'italic' },
      { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-muted)' },
      { tag: t.link, color: 'var(--text-accent)' },
      { tag: t.url, color: 'var(--text-faint)', textDecoration: 'underline' },
      { tag: t.monospace, fontFamily: 'var(--font-mono)', color: 'var(--code-text)', fontSize: '0.92em' },
      { tag: t.quote, color: 'var(--text-muted)', fontStyle: 'italic' },
      { tag: [t.processingInstruction, t.meta, t.contentSeparator, t.labelName], color: 'var(--text-faint)' },
      { tag: [t.keyword, t.atom], color: 'var(--text-accent)' },
      { tag: t.comment, color: 'var(--text-faint)', fontStyle: 'italic' }
    ]);

    // 프론트매터 줄은 흐린 고정폭 글꼴로
    const frontmatterLines = !CM.Decoration ? [] : CM.EditorView.decorations.compute(['doc'], (state) => {
      const builder = [];
      const doc = state.doc;
      if (doc.lines > 1 && /^---\s*$/.test(doc.line(1).text)) {
        for (let i = 1; i <= doc.lines; i++) {
          builder.push(CM.Decoration.line({ class: 'cm-frontmatter' }).range(doc.line(i).from));
          if (i > 1 && /^(---|\.\.\.)\s*$/.test(doc.line(i).text)) break;
          if (i > 300) break;
        }
      }
      return CM.Decoration.set(builder);
    });

    const theme = CM.EditorView.theme({
      '.cm-frontmatter': { fontFamily: 'var(--font-mono)', fontSize: '0.86em', color: 'var(--text-muted)', backgroundColor: 'var(--bg-soft)' },
      '&': { height: '100%', fontSize: 'calc(15.5px * var(--ed-zoom, 1))', backgroundColor: 'var(--bg)', color: 'var(--text)' },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { fontFamily: 'var(--font-body)', lineHeight: '1.75', padding: '28px 0 40vh' },
      '.cm-content': {
        maxWidth: 'var(--content-w)', margin: '0 auto', padding: '0 36px',
        caretColor: 'var(--accent)', wordBreak: 'keep-all', overflowWrap: 'anywhere'
      },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
      '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--interactive-accent) 6%, transparent)' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
        backgroundColor: 'color-mix(in srgb, var(--interactive-accent) 26%, transparent) !important'
      },
      '.cm-selectionMatch': { backgroundColor: 'var(--mark-bg)' },
      '.cm-searchMatch': { backgroundColor: 'var(--find-bg)', borderRadius: '2px' },
      '.cm-searchMatch-selected': { backgroundColor: 'var(--find-current)' },
      '.cm-panels': { backgroundColor: 'var(--toolbar-bg)', color: 'var(--text)', borderColor: 'var(--border)' },
      '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
      '.cm-panel.cm-search': { padding: '8px 12px', fontSize: '13px', fontFamily: 'var(--font-body)' },
      '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontFamily: 'inherit', fontSize: '13px' },
      '.cm-textfield': {
        border: '1px solid var(--border)', borderRadius: '6px', background: 'var(--bg)',
        color: 'var(--text)', padding: '3px 8px'
      },
      '.cm-button': {
        backgroundImage: 'none', background: 'var(--bg-hover)', border: '1px solid var(--border)',
        borderRadius: '6px', color: 'var(--text)', padding: '3px 10px'
      },
      '.cm-tooltip': { border: '1px solid var(--border)', background: 'var(--bg)', borderRadius: '8px', boxShadow: 'var(--shadow)', overflow: 'hidden' },
      '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-body)', maxHeight: '18em' },
      '.cm-tooltip-autocomplete > ul > li': { padding: '4px 10px !important' },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': { background: 'var(--accent-soft)', color: 'var(--text)' },
      '.cm-completionDetail': { color: 'var(--text-faint)', fontStyle: 'normal', marginLeft: '10px', fontSize: '0.85em' },
      '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--accent)', fontWeight: '700' }
    });

    // [[ 를 치면 노트 이름 자동완성
    function wikiCompletion(context) {
      const m = context.matchBefore(/\[\[[^\]\|#\n]*$/);
      if (!m) return null;
      const notes = opts.getNotes ? opts.getNotes() : [];
      return {
        from: m.from + 2,
        validFor: /^[^\]\|#\n]*$/,
        options: notes.map((n) => ({
          label: n.name,
          detail: n.dir || '',
          apply: (view, completion, from, to) => {
            const after = view.state.sliceDoc(to, to + 2);
            const insert = completion.label + (after === ']]' ? '' : ']]');
            view.dispatch({
              changes: { from, to, insert },
              selection: { anchor: from + completion.label.length + 2 }
            });
          }
        }))
      };
    }

    // 선택 영역을 기호로 감싸거나 풀기 (Ctrl+B, Ctrl+I 등)
    function wrapWith(mark) {
      return (view) => {
        const changes = view.state.changeByRange((range) => {
            const before = view.state.sliceDoc(range.from - mark.length, range.from);
          const after = view.state.sliceDoc(range.to, range.to + mark.length);
          if (before === mark && after === mark) {
            return {
              changes: [{ from: range.from - mark.length, to: range.from }, { from: range.to, to: range.to + mark.length }],
              range: CM.EditorSelection.range(range.from - mark.length, range.to - mark.length)
            };
          }
          return {
            changes: [{ from: range.from, insert: mark }, { from: range.to, insert: mark }],
            range: CM.EditorSelection.range(range.from + mark.length, range.to + mark.length)
          };
        });
        view.dispatch(view.state.update(changes, { scrollIntoView: true, userEvent: 'input' }));
        return true;
      };
    }

    // 링크 만들기 (Ctrl+K): 선택한 글자를 [글자]() 로
    function makeLink(view) {
      const r = view.state.selection.main;
      const text = view.state.sliceDoc(r.from, r.to);
      const insert = '[' + text + ']()';
      view.dispatch({
        changes: { from: r.from, to: r.to, insert },
        selection: { anchor: r.from + insert.length - 1 },
        userEvent: 'input'
      });
      return true;
    }

    const custom = [
      { key: 'Mod-s', preventDefault: true, run: () => { opts.onSave && opts.onSave(); return true; } },
      { key: 'Mod-e', preventDefault: true, run: () => { opts.onToggle && opts.onToggle(); return true; } },
      { key: 'Escape', run: () => { if (opts.onEscape) return opts.onEscape(); return false; } },
      { key: 'Mod-b', run: wrapWith('**') },
      { key: 'Mod-i', run: wrapWith('*') },
      { key: 'Mod-Shift-h', run: wrapWith('==') },
      { key: 'Mod-Shift-x', run: wrapWith('~~') },
      { key: 'Mod-`', run: wrapWith('`') },
      { key: 'Mod-k', run: makeLink }
    ];

    const view = new CM.EditorView({
      parent,
      state: CM.EditorState.create({
        doc: opts.doc || '',
        extensions: [
          CM.history(),
          CM.drawSelection(),
          CM.highlightActiveLine(),
          CM.EditorView.lineWrapping,
          CM.markdown({ base: CM.markdownLanguage, extensions: [Frontmatter] }),
          frontmatterLines,
          CM.syntaxHighlighting(highlight),
          CM.bracketMatching(),
          CM.highlightSelectionMatches(),
          CM.search({ top: true }),
          CM.autocompletion({ override: [wikiCompletion], icons: false, activateOnTyping: true }),
          CM.EditorState.phrases.of(KO_PHRASES),
          CM.EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', 'aria-label': '마크다운 편집' }),
          CM.keymap.of([...custom, ...CM.completionKeymap, ...CM.searchKeymap, ...CM.historyKeymap, ...CM.defaultKeymap, CM.indentWithTab]),
          CM.EditorView.updateListener.of((u) => {
            if (u.docChanged && opts.onChange) opts.onChange();
          }),
          CM.EditorView.domEventHandlers({
            scroll: () => { if (opts.onScroll) opts.onScroll(); }
          }),
          theme
        ]
      })
    });

    return {
      view,
      getText: () => view.state.doc.toString(),
      /** 바깥에서 바뀐 내용으로 교체 (커서 위치는 가능한 한 유지) */
      setText(text) {
        const cur = view.state.selection.main.head;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: Math.min(cur, text.length) },
          annotations: [],
          userEvent: 'external'
        });
      },
      focus: () => view.focus(),
      destroy: () => view.destroy(),
      scrollRatio() {
        const s = view.scrollDOM;
        const max = s.scrollHeight - s.clientHeight;
        return max > 0 ? s.scrollTop / max : 0;
      },
      setScrollRatio(r) {
        const s = view.scrollDOM;
        s.scrollTop = r * Math.max(0, s.scrollHeight - s.clientHeight);
      },
      openSearch: () => CM.openSearchPanel(view)
    };
  }

  window.MdEditor = { create, available: () => !!window.CM };
})();
