// 뷰어가 사용하는 라이브러리를 하나의 IIFE 번들(wwwroot/vendor/vendor.js)로 묶는다.
import MarkdownIt from 'markdown-it';
import katex from 'katex';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';
import yaml from 'js-yaml';

window.markdownit = MarkdownIt;
window.MdVendor = { katex, hljs, DOMPurify, yaml };
