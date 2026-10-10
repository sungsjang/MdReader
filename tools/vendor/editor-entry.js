// 편집 모드용 CodeMirror 6 모듈을 하나의 IIFE 번들(wwwroot/vendor/editor.js)로 묶는다.
// 실제 편집기 구성은 wwwroot/js/editor.js 에서 한다.
import { EditorState, EditorSelection, Compartment } from '@codemirror/state';
import { EditorView, Decoration, ViewPlugin, keymap, drawSelection, highlightActiveLine, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle, bracketMatching } from '@codemirror/language';
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { tags, styleTags } from '@lezer/highlight';

window.CM = {
  EditorState, EditorSelection, Compartment,
  EditorView, Decoration, ViewPlugin, keymap, drawSelection, highlightActiveLine, placeholder,
  defaultKeymap, history, historyKeymap, indentWithTab,
  markdown, markdownLanguage,
  syntaxHighlighting, HighlightStyle, bracketMatching,
  search, searchKeymap, highlightSelectionMatches, openSearchPanel,
  autocompletion, completionKeymap,
  tags, styleTags
};
