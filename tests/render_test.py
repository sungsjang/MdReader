"""
헤드리스 Chromium에서 뷰어(wwwroot)를 띄우고, C# 호스트를 흉내 내는 목(mock)으로
샘플 볼트를 렌더링해 검사·스크린샷한다. (탭·사이드바·검색·백링크 포함)

사용법: python tests/render_test.py [출력폴더]
"""
import json
import mimetypes
import sys
from pathlib import Path
from urllib.parse import unquote

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
WWW = ROOT / "src/MdReader/wwwroot"
VAULT = ROOT / "samples/SampleVault"
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "tests/out"
OUT.mkdir(parents=True, exist_ok=True)

files = sorted(p.relative_to(VAULT).as_posix() for p in VAULT.rglob("*")
               if p.is_file() and not any(part.startswith(".") for part in p.relative_to(VAULT).parts))
notes = {f: (VAULT / f).read_text(encoding="utf-8") for f in files if f.endswith(".md")}
snippet = (VAULT / ".obsidian/snippets/mdreader-demo.css").read_text(encoding="utf-8")

# C# MainWindow 의 동작을 단순화해 흉내 낸다
MOCK = r"""
window.__vault = %s;
window.__notes = %s;
window.__css = %s;
window.__sent = [];
(function () {
  const H = { tabs: [], active: null, seq: 0, css: true };
  const reply = (m) => setTimeout(() => window.__mdreader.handle(m), 0);
  const files = window.__vault;
  function findPath(target, from, relative) {
    let t = target.replace(/\\/g, '/');
    const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
    const forms = [t + '.md', t];
    if (relative) for (const f of forms) if (files.includes(dir + f)) return dir + f;
    for (const f of forms) if (files.includes(f)) return f;
    for (const f of forms) {
      const name = f.split('/').pop().toLowerCase();
      const hit = files.filter(p => p.split('/').pop().toLowerCase() === name);
      if (hit.length) return hit.sort((a, b) => a.length - b.length)[0];
    }
    return null;
  }
  const cur = () => H.tabs.find(t => t.id === H.active);
  const pathOf = (t) => t && t.hist[t.i];
  function postTabs() {
    reply({ type: 'tabs', active: H.active, tabs: H.tabs.map(t => ({ id: t.id, path: pathOf(t) || null,
      title: pathOf(t) ? pathOf(t).split('/').pop().replace(/\.md$/, '') : '새 탭' })) });
  }
  function show(extra) {
    postTabs();
    const t = cur(), p = pathOf(t);
    if (!p) return reply({ type: 'welcome', recent: ['C:/Notes/최근 문서.md'] });
    reply(Object.assign({ type: 'load', tabId: t.id, path: p, name: p.split('/').pop().replace(/\.md$/, ''),
      relPath: p, vaultKey: 'v1.mdreader', vaultName: 'SampleVault', vaultRoot: 'C:/SampleVault', isVault: true,
      markdown: window.__notes[p], notes: t.sentIndex ? null : files, scroll: 0,
      canBack: t.i > 0, canForward: t.i < t.hist.length - 1, recent: ['Notes/프로젝트 계획.md'], css: H.css ? window.__css : null }, extra || {}));
    t.sentIndex = true;
  }
  function addTab() { const t = { id: ++H.seq, hist: [], i: -1 }; H.tabs.push(t); return t; }
  function open(p, newTab, extra) {
    let t = newTab || !cur() ? addTab() : cur();
    t.hist = t.hist.slice(0, t.i + 1); t.hist.push(p); t.i = t.hist.length - 1;
    H.active = t.id; show(extra);
  }
  window.__mockHost = (msg) => {
    window.__sent.push(msg);
    switch (msg.type) {
      case 'ready':
        reply({ type: 'settings', theme: 'light', zoom: 1, sidebarVisible: true, sidebarPane: 'files', sidebarWidth: 260, cssSnippets: true, restoreSession: true, hoverPreview: true });
        open('Welcome.md', true);
        break;
      case 'newTab': H.active = addTab().id; show(); break;
      case 'switchTab': H.active = msg.id; show(); break;
      case 'closeTab': H.tabs = H.tabs.filter(t => t.id !== msg.id); if (!H.tabs.length) addTab(); if (!cur()) H.active = H.tabs[H.tabs.length - 1].id; show(); break;
      case 'navigate': { const p = findPath(msg.target.split('#')[0], 'Welcome.md'); if (p) open(p, msg.newTab, { anchor: msg.target.split('#')[1] }); break; }
      case 'openRel': open(msg.rel, msg.newTab, { find: msg.find }); break;
      case 'back': { const t = cur(); if (t.i > 0) { t.i--; show(); } break; }
      case 'setting': if (msg.key === 'cssSnippets') { H.css = msg.value; show({ keepScroll: true }); } break;
      case 'resolve': {
        const tt = msg.target.split('#')[0];
        const p = findPath(tt, msg.from || '', msg.relative);
        if (!p) return reply({ type: 'resolved', id: msg.id, found: false });
        const name = p.split('/').pop().replace(/\.md$/, '');
        if (p.endsWith('.md')) return reply({ type: 'resolved', id: msg.id, found: true, kind: 'note', path: p, name, markdown: window.__notes[p] });
        reply({ type: 'resolved', id: msg.id, found: true, kind: 'image', path: p, name, url: 'https://v1.mdreader/' + encodeURI(p) });
        break;
      }
      case 'backlinks': {
        const target = pathOf(cur()); const name = target.split('/').pop().replace(/\.md$/, '');
        const items = Object.entries(window.__notes).filter(([p]) => p !== target).map(([p, txt]) => ({
          path: p, rel: p, name: p.split('/').pop().replace(/\.md$/, ''),
          lines: txt.split('\n').filter(l => l.includes('[[' + name)).map(l => l.trim()).slice(0, 5)
        })).filter(x => x.lines.length);
        reply({ type: 'backlinks', reqId: msg.reqId, path: target, items });
        break;
      }
      case 'search': {
        const terms = msg.query.split(/\s+/).filter(Boolean);
        const items = Object.entries(window.__notes).filter(([p, txt]) =>
          terms.every(t => txt.toLowerCase().includes(t.toLowerCase()))).map(([p, txt]) => {
            const lines = txt.split('\n').map((l, i) => ({ n: i + 1, text: l.trim() }))
              .filter(l => terms.some(t => l.text.toLowerCase().includes(t.toLowerCase())));
            return { path: p, rel: p, name: p.split('/').pop().replace(/\.md$/, ''), nameMatch: false, count: lines.length, lines: lines.slice(0, 5) };
          });
        reply({ type: 'searchResults', reqId: msg.reqId, query: msg.query, items, truncated: false });
        break;
      }
    }
  };
})();
""" % (json.dumps(files, ensure_ascii=False), json.dumps(notes, ensure_ascii=False), json.dumps(snippet))


def serve(route, base: Path, prefix: str):
    rel = unquote(route.request.url[len(prefix):].split("?")[0])
    p = base / rel
    if p.is_file():
        route.fulfill(status=200, body=p.read_bytes(),
                      headers={"content-type": mimetypes.guess_type(p.name)[0] or "application/octet-stream"})
    else:
        route.fulfill(status=404, body=b"")


def main():
    errors = []
    results = {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 860})
        page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
        page.on("console", lambda m: m.type in ("error", "warning") and errors.append(f"console.{m.type}: {m.text}"))
        page.on("dialog", lambda d: (errors.append("DIALOG (xss!): " + d.message), d.dismiss()))
        page.route("https://app.mdreader/**", lambda r: serve(r, WWW, "https://app.mdreader/"))
        page.route("https://v1.mdreader/**", lambda r: serve(r, VAULT, "https://v1.mdreader/"))
        page.add_init_script(MOCK)
        page.goto("https://app.mdreader/index.html")
        page.wait_for_selector(".mermaid-block svg", timeout=15000)
        page.wait_for_timeout(300)

        d = lambda js: page.evaluate(js)
        results["render"] = d("""() => {
          const doc = document.getElementById('doc');
          return {
            wikilinks: doc.querySelectorAll('a.internal-link').length,
            unresolved: doc.querySelectorAll('a.is-unresolved').length,
            callouts: doc.querySelectorAll('.callout').length,
            embeds: doc.querySelectorAll('.embed-note').length,
            katex: doc.querySelectorAll('.katex').length,
            snippet_applied: getComputedStyle(doc.querySelector('h2'), '::before').content,
            tabs: [...document.querySelectorAll('.tab')].map(t => t.textContent.trim()),
            tree: [...document.querySelectorAll('#file-tree a')].map(a => a.textContent.trim()),
          };
        }""")
        page.screenshot(path=str(OUT / "1-files-pane.png"))

        # 폴더 펼치기
        page.click("#file-tree a.tree-dir >> text=Notes")
        page.click("#file-tree a.tree-dir >> text=회의록")
        results["tree_expanded"] = d("[...document.querySelectorAll('#file-tree a')].map(a => a.textContent.trim())")

        # Ctrl+클릭 → 새 탭
        page.click("#doc a.internal-link >> text=계획 문서 보기", modifiers=["Control"])
        page.wait_for_timeout(300)
        results["tabs_after_ctrl_click"] = d("[...document.querySelectorAll('.tab')].map(t => (t.classList.contains('active') ? '*' : '') + t.textContent.trim())")

        # 백링크
        page.keyboard.press("Control+Shift+B")
        page.wait_for_timeout(300)
        results["backlinks"] = d("[...document.querySelectorAll('#backlinks .sr-name')].map(e => e.textContent)")
        results["bl_badge"] = d("document.getElementById('bl-badge').textContent")
        page.screenshot(path=str(OUT / "2-backlinks-tabs.png"))

        # 볼트 검색 → 결과 클릭 → 문서 안 찾기 강조
        page.keyboard.press("Control+Shift+F")
        page.keyboard.type("MVP")
        page.wait_for_selector("#search-results .sr-item", timeout=3000)
        results["search"] = d("[...document.querySelectorAll('#search-results .sr-name')].map(e => e.textContent)")
        page.screenshot(path=str(OUT / "3-search.png"))
        page.click("#search-results .sr-item >> nth=0")
        page.wait_for_timeout(400)
        results["find_after_search"] = d("document.getElementById('find-count').textContent")

        # 태그 클릭 → 볼트 검색
        page.keyboard.press("Escape")
        page.keyboard.press("Control+1")
        page.wait_for_timeout(300)
        page.click("#doc a.tag >> nth=0")
        page.wait_for_timeout(300)
        results["tag_search_query"] = d("document.getElementById('vault-search').value")

        # 새 탭 / 닫기 / 탭 순환
        page.keyboard.press("Control+t")
        page.wait_for_timeout(200)
        results["welcome_visible"] = d("!document.getElementById('welcome').hidden")
        page.keyboard.press("Control+w")
        page.wait_for_timeout(200)
        results["tabs_final"] = d("[...document.querySelectorAll('.tab')].map(t => (t.classList.contains('active') ? '*' : '') + t.textContent.trim())")

        # 다크 테마 + 목차
        page.evaluate("window.__mdreader.handle({type:'settings', theme:'dark', zoom:1, sidebarVisible:true, sidebarPane:'toc', sidebarWidth:280, cssSnippets:true, restoreSession:true})")
        page.wait_for_timeout(900)
        page.screenshot(path=str(OUT / "4-dark-toc.png"))

        # 스니펫 끄기
        page.click("[data-cmd=menu]")
        page.click("#menu-snippets")
        page.wait_for_timeout(300)
        results["snippet_off"] = d("getComputedStyle(document.querySelector('#doc h2'), '::before').content")

        # ── 링크 미리보기 ──
        page.evaluate("window.__mdreader.handle({type:'settings', theme:'light', zoom:1, sidebarVisible:true, sidebarPane:'files', sidebarWidth:260, cssSnippets:true, restoreSession:true, hoverPreview:true})")
        page.keyboard.press("Control+1")
        page.wait_for_timeout(400)
        page.evaluate("document.getElementById('main').scrollTop = 0")
        page.hover("#doc a.internal-link >> text=프로젝트 계획 > 일정")
        page.wait_for_selector("#preview:not([hidden]) .hp-body table", timeout=3000)
        results["preview"] = d("({ title: document.querySelector('#preview .hp-title').textContent, body: document.querySelector('#preview .hp-body').innerText.slice(0, 60) })")
        page.screenshot(path=str(OUT / "5-hover-preview.png"))
        page.mouse.move(5, 500)
        page.wait_for_timeout(500)
        results["preview_hidden_after_leave"] = d("document.getElementById('preview').hidden")

        # ── 빠른 이동 (초성) ──
        page.keyboard.press("Control+p")
        page.wait_for_selector("#switcher:not([hidden])")
        results["switcher_empty_list"] = d("[...document.querySelectorAll('#sw-list .sw-name')].map(e => e.textContent)")
        page.keyboard.type("ㅋㅇㅍ")
        page.wait_for_timeout(150)
        results["switcher_cho"] = d("[...document.querySelectorAll('#sw-list .sw-name')].map(e => e.textContent)")
        page.screenshot(path=str(OUT / "6-switcher.png"))
        page.keyboard.press("Enter")
        page.wait_for_timeout(400)
        results["after_switch_title"] = d("document.getElementById('file-name').textContent")
        results["scroll_reports"] = d("window.__sent.filter(m => m.type === 'scrollPos').length")

        browser.close()
    print(json.dumps(results, ensure_ascii=False, indent=1))
    print("errors:", json.dumps(errors, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
