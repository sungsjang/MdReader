# MdReader

Obsidian 노트를 잘 읽는 **마크다운 뷰어** (Windows) — 필요할 때는 간단히 고칠 수도 있습니다.
아크로뱃 리더가 PDF를 "보기만" 하듯, `.md` 파일을 더블클릭하면 바로 깔끔하게 열어 줍니다.

- C# / .NET 8 WPF + WebView2(Windows 10/11 기본 탑재) — 설치 파일 작고 가벼움
- 렌더링은 markdown-it + 직접 작성한 Obsidian 확장 (`wwwroot/js/obsidian.js`)
- 인터넷 연결 없이 동작 (라이브러리는 `wwwroot/vendor`에 포함)

## 지원 문법

| 구분 | 내용 |
|---|---|
| 기본 | CommonMark, 표, 취소선, 자동 링크, HTML(스크립트 제거) |
| Obsidian | `[[위키링크]]`, `[[노트\|별칭]]`, `[[노트#제목]]`, `[[#제목]]`, `[[노트#^블록]]` |
| 임베드 | `![[그림.png\|300]]`, `![[노트]]`, `![[노트#제목]]`, `![[노트#^블록]]`, PDF·오디오·비디오 |
| 콜아웃 | `> [!note]`, `> [!tip]+`, `> [!warning]-` (접기), 중첩, 별칭 유형 전체 |
| 기타 | `==하이라이트==`, `%%주석%%`, `#태그`, 프론트매터(속성 표), `- [ ]`/`- [x]`/`- [-]`, 각주 `[^1]`·`^[인라인]` |
| 수식·도표 | `$인라인$`, `$$블록$$` (KaTeX), ` ```mermaid ` |
| 코드 | 구문 강조(highlight.js) |
| 미지원 | Dataview·Templater 등 플러그인 실행 결과 (코드 블록으로 표시) |

링크 해석은 Obsidian과 같은 방식입니다: 파일 위쪽에서 `.obsidian` 폴더를 찾아 볼트 루트로 삼고,
같은 이름이 여럿이면 현재 노트와 같은 폴더 → 가장 짧은 경로 순으로 고릅니다.
없는 노트로 가는 링크는 흐리게 표시됩니다.

## 기능

- **탭** — 링크를 Ctrl+클릭(또는 가운데 버튼)하면 새 탭, 탐색기에서 .md를 더블클릭해도 새 창 대신 기존 창의 새 탭으로 열림.
  종료할 때 열려 있던 탭은 다음 실행 때 복원(메뉴에서 끌 수 있음)
- **사이드바** (Ctrl+\\)
  - 파일: 볼트(또는 폴더) 트리, 이름으로 거르기, 현재 문서 위치 자동 펼침
  - 볼트 검색: 여러 단어(모두 포함), `"정확한 구절"`, `#태그`/`tag:태그`(하위 태그 포함·프론트매터 tags 포함), `file:이름`.
    결과를 누르면 해당 노트가 열리고 검색어가 문서 안에서 강조됨
  - 목차: 현재 위치 강조
  - 백링크: 이 노트를 `[[링크]]`·`[텍스트](노트.md)`로 가리키는 노트와 그 줄
- **편집 모드** (Ctrl+E) — 평소엔 읽기, 필요할 때만 원문 편집. `편집`/`나란히`(편집+실시간 미리보기) 전환, Ctrl+S 저장
  - 마크다운 문법 색 구분, `[[`를 치면 노트 이름 자동완성, 목록에서 Enter 시 자동 이어쓰기
  - Ctrl+B 굵게 · Ctrl+I 기울임 · Ctrl+Shift+H 하이라이트 · Ctrl+K 링크 · Ctrl+F 찾기/바꾸기 · Ctrl+Z 되돌리기
  - 원래 인코딩(UTF-8/BOM/CP949)과 줄바꿈(CRLF/LF)을 유지해 저장, 임시 파일에 쓴 뒤 바꿔치기해서 저장 중 끊겨도 원본 보호
  - 저장 안 한 상태로 다른 문서로 이동·탭 닫기·창 닫기 시 확인, Obsidian 등 바깥에서 같은 파일이 바뀌면 알림·덮어쓰기 확인
- **링크 미리보기** — 내부 링크에 마우스를 올리면 그 노트(또는 `#제목`·`#^블록` 구간, 그림)를 팝업으로 보여줌. 메뉴에서 끌 수 있음
- **빠른 이동** (Ctrl+P) — 노트 이름 일부나 **초성**(`ㅍㄹㅈㅌ` → 프로젝트 계획)으로 바로 열기. 빈 칸이면 최근 파일
- **읽던 위치 기억** — 파일을 다시 열면 마지막으로 읽던 곳에서 시작 (최근 300개 파일)
- 본문의 `#태그`를 누르면 볼트 전체에서 그 태그를 검색
- **Obsidian CSS 스니펫** — `.obsidian/appearance.json`에서 켜 둔 스니펫을 그대로 적용.
  Obsidian과 같은 이름의 CSS 변수(`--background-primary`, `--text-normal`, `--callout-color` …)와
  클래스(`.markdown-preview-view`, `.theme-dark`, 프론트매터 `cssclasses`)를 쓰므로 단순한 스니펫은 대부분 동작
- **문서 내 찾기**(Ctrl+F), 라이트/다크 테마, 확대/축소
- 링크를 따라가며 **뒤로/앞으로** (탭마다 따로, Alt+←/→, 마우스 뒤로가기 버튼, Backspace)
- 파일이 바뀌면 **자동 새로고침**(스크롤 위치 유지) — Obsidian에서 편집하며 옆에 띄워 두기 좋음
- 창에 파일 **끌어다 놓기**, 최근 파일, 인쇄/PDF 저장, 탐색기에서 보기, Obsidian에서 열기
- 한글 경로·파일명, UTF-8/UTF-16/CP949(EUC-KR) 파일 자동 판별

| 단축키 | 동작 |
|---|---|
| Ctrl+E / Ctrl+S | 편집 모드 전환 / 저장 |
| Ctrl+P | 빠른 이동 (노트 이름·초성) |
| Ctrl+O | 열기 (여러 개 선택 가능) |
| Ctrl+T / Ctrl+W / Ctrl+Shift+T | 새 탭 / 탭 닫기 / 닫은 탭 다시 열기 |
| Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+1~9 | 다음 탭 / 이전 탭 / N번째 탭 |
| Ctrl+F / F3 / Shift+F3 | 문서에서 찾기 / 다음 / 이전 |
| Ctrl+\\ | 사이드바 보이기/숨기기 |
| Ctrl+Shift+E / F / O / B | 파일 / 볼트 검색 / 목차 / 백링크 |
| Ctrl+D | 라이트/다크 전환 |
| Ctrl+= / Ctrl+- / Ctrl+0 / Ctrl+휠 | 확대 / 축소 / 100% |
| F5 | 새로고침 |
| Ctrl+Shift+P | 인쇄 (PDF로 저장 가능) |

## 빌드

필요: Windows 10/11, [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)

```powershell
cd src\MdReader
dotnet run -- "C:\경로\노트.md"            # 바로 실행해 보기

# 배포용 단일 실행 파일 (publish 폴더의 MdReader.exe + wwwroot 폴더를 함께 복사)
dotnet publish -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -o ..\..\publish
```

Visual Studio 2022에서는 `src\MdReader\MdReader.csproj`를 열고 F5.
GitHub에 올리면 `.github/workflows/build.yml`이 Windows 러너에서 포터블 실행 파일과 설치 파일을 만들어 아티팩트로 올려 줍니다.

### 설치 파일 만들기

[Inno Setup 6](https://jrsoftware.org/isdl.php)을 설치(`winget install JRSoftware.InnoSetup`)한 뒤:

```powershell
powershell -ExecutionPolicy Bypass -File installer\build-installer.ps1 -Version 0.4.0
# → dist\MdReader-Setup-0.4.0.exe
```

설치 파일은 .NET 런타임을 포함(self-contained)하므로 다른 PC에 .NET이 없어도 됩니다.
관리자 권한 없이 `%LOCALAPPDATA%\Programs\MdReader`에 설치되고, 시작 메뉴 바로가기와 `.md` 연결 프로그램을 등록합니다.

### .md 파일을 더블클릭으로 열기

설치 파일로 설치했거나 앱의 `⋯` 메뉴 → **".md 파일 '연결 프로그램'에 등록"** 을 누른 뒤,
아무 `.md` 파일 우클릭 → 연결 프로그램 → 다른 앱 선택 → MdReader → "항상 이 앱 사용".
(Windows 정책상 기본 앱은 사용자가 직접 골라야 합니다.)

새 창으로 따로 열고 싶으면 `MdReader.exe --new-window 파일.md`.

### 뷰어 라이브러리 갱신 (선택)

`wwwroot/vendor`는 이미 빌드되어 있습니다. 버전을 올리고 싶을 때만 (또는 `tools/vendor`를 바꿔 올리면 `vendor` 워크플로가 `vendor-bundle` 브랜치에 새 번들을 만들어 줍니다):

```powershell
cd tools\vendor
npm install
npm run build
```

## 구조

```
src/MdReader/
  App.xaml(.cs)            시작, 명령줄 인자, 단일 인스턴스
  SingleInstance.cs        이미 실행 중인 창으로 파일 넘기기 (Named Pipe)
  MainWindow.xaml(.cs)     WebView2 호스트: 탭, 파일 읽기·감시, 링크/임베드 해석, 백링크·검색 요청, 설정
  VaultIndex.cs            볼트 파일 색인, Obsidian식 링크 해석, 백링크·전체 검색용 내용 캐시, CSS 스니펫
  TextFile.cs              인코딩 자동 판별 읽기
  FileAssociation.cs       '연결 프로그램' 등록 (HKCU)
  NavigationHistory.cs, Debouncer.cs, AppSettings.cs, Native.cs
  wwwroot/
    index.html, css/app.css
    js/obsidian.js         Obsidian 문법 렌더러 (markdown-it 플러그인)
    js/app.js              뷰어 UI (탭, 사이드바, 찾기, 테마, 편집 모드, 임베드 처리, 호스트 통신)
    js/editor.js           편집기 구성 (CodeMirror 6)
    vendor/                markdown-it, KaTeX, highlight.js, DOMPurify, js-yaml, Mermaid, CodeMirror 6(editor.js)
installer/                 Inno Setup 스크립트 + 빌드 스크립트
samples/SampleVault/       렌더링 확인용 샘플 볼트 (CSS 스니펫 포함)
tests/render_test.py       헤드리스 Chromium 렌더링 테스트 (Playwright)
```

설정은 `%APPDATA%\MdReader\settings.json`에 저장됩니다.

## 로드맵

- [x] 1단계 MVP — 열기·연결 프로그램·테마·자동 새로고침
- [x] 2단계 Obsidian 문법 — 볼트 인식, 위키링크, 임베드, 콜아웃 등
- [x] 3단계 읽기 편의 — 목차, 찾기, 수식, Mermaid, 구문 강조, 확대, 기록
- [x] 4단계 — 탭·단일 창, 파일 탐색 사이드바, 백링크, 볼트 검색·태그 검색, CSS 스니펫, 설치 프로그램
- [x] 링크 미리보기, 빠른 이동(초성 검색), 읽던 위치 기억
- [x] 간단한 편집 모드 (편집/나란히, 저장, 자동완성, 충돌 확인)
- [ ] 다음 후보 — 새 노트 만들기, 그림 붙여넣기, 탭 끌어서 순서 바꾸기, 나가는 링크/언링크드 멘션, 그래프 뷰, Canvas(.canvas) 보기,
      Obsidian 테마(.obsidian/themes) 적용, 자동 업데이트

## 라이선스

포함된 라이브러리: markdown-it(MIT), KaTeX(MIT), highlight.js(BSD-3), DOMPurify(Apache-2.0/MPL-2.0),
js-yaml(MIT), Mermaid(MIT), CodeMirror(MIT). 각 라이브러리의 라이선스를 따릅니다.
