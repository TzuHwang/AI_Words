# AI Words

**繁體中文** · [English](README.md)

> 一個 LibreOffice 風格的 ODT 文件編輯器，右側內建串流式 AI 助理。
> 打開文件、（在 AI 協助下）直接於瀏覽器編輯，完成後匯出回檔案。

<p>
  <img alt="Python" src="https://img.shields.io/badge/python-3.10%2B-blue">
  <img alt="FastAPI" src="https://img.shields.io/badge/FastAPI-async-009688">
  <img alt="Status" src="https://img.shields.io/badge/status-MVP-orange">
</p>

---

## 目錄

- [簡介](#簡介)
- [啟發](#啟發)
- [功能特色](#功能特色)
- [資料結構](#資料結構)
- [從零開始的使用說明](#從零開始的使用說明)
- [設定 AI 模型](#設定-ai-模型)
- [使用方式](#使用方式)
- [加入 LaTeX 模板](#加入-latex-模板)
- [執行測試](#執行測試)
- [打包成單一執行檔](#打包成單一執行檔)
- [開發藍圖](#開發藍圖)
- [授權](#授權)

---

## 簡介

**AI Words** 是一個獨立可執行的桌面應用程式。啟動後會自動在瀏覽器開啟一個頁面，畫面分成左右兩個面板：

- **左側 — 文件編輯器：** 仿照 Word / LibreOffice 寫作體驗的富文字編輯區。
- **右側 — AI 助理：** 以聊天介面驅動編輯的指令列互動區，靈感來自 *Claude Code for VS Code*。

核心的文件處理流程分為三步：

1. **匯入（Import）：** 載入 ODT 檔並轉描繪成 HTML 以供顯示與編輯。
2. **編輯（Edit）：** 使用者（或 AI 助理）在瀏覽器中修改 HTML 內容。
3. **匯出（Export）：** 儲存時將編輯後的 HTML 序列化回 ODT（或其他格式）。

目標是讓使用者能打開一份文件、在瀏覽器裡直接編輯（無論是否使用 AI），並在完成後匯出成檔案。

ODT 轉換預設採用純 Python（`odfpy`）實作；若系統上偵測到 LibreOffice 的 `soffice` 執行檔，會自動改用它做更高保真度的轉換。

## 啟發

本專案的想法源自 [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)——將辦公文件交由 AI 代理讀寫的概念。

而右側 AI 助理的互動形式，則參考了 *Claude Code for VS Code*：以輕量、指令驅動的聊天介面，讓使用者透過斜線指令切換模型、載入技能、請代理閱讀與編輯當前文件。

## 功能特色

- 🖥️ **單一執行檔啟動** — 啟動即在瀏覽器開啟雙面板編輯器。
- 📄 **ODT ⇄ HTML** — 匯入 ODT 描繪成可編輯 HTML，儲存時再匯出回 ODT / HTML。
- ✍️ **富文字編輯** — 粗體 / 斜體 / 底線、標題、清單等工具列操作。
- 🤖 **串流式 AI 助理** — 支援 Anthropic API 與任何 OpenAI 相容的本地伺服器（Ollama、LM Studio…）。
- 🔀 **模型切換** — 從下拉選單或以 `/model <id>` 即時切換本地／雲端模型。
- 🧩 **技能（Skills）** — 可建立與載入可重複使用的指令 / 工具集。
- 🧠 **推理模型支援** — 會自動剝除 `<think>…</think>` 推理內容，不干擾對話顯示。

## 資料結構

```text
AI_Words/
├── run.py                  # 便捷啟動器：python run.py（等同 python -m app）
├── pyproject.toml          # Poetry 專案設定與相依套件
├── Dockerfile              # 純 Python（無 LibreOffice）的精簡映像
├── config.json             # 首次執行時產生：模型後端與啟用中的選擇
├── LICENSE
│
├── app/                    # 應用程式套件
│   ├── __main__.py         # CLI 進入點：解析參數、啟動 uvicorn、開瀏覽器
│   ├── server.py           # FastAPI：頁面 + JSON/SSE API
│   ├── converter.py        # ODT ⇄ HTML（odfpy；選用 LibreOffice）
│   ├── ai.py               # 串流聊天（Anthropic + OpenAI 相容後端）
│   ├── config.py           # 模型後端與啟用中的選擇管理
│   ├── skills.py           # 技能的儲存與載入（skills/*.md）
│   └── static/             # 雙面板網頁 UI
│       ├── index.html
│       ├── style.css
│       └── app.js
│
└── skills/                 # 技能定義（Markdown）
    └── language-consistency.md
```

**資料流概觀：**

```text
瀏覽器 UI (app/static)
      │  HTTP / SSE
      ▼
FastAPI (app/server.py)
      ├── converter.py  ── ODT ⇄ HTML
      ├── ai.py         ── 串流至 Anthropic / 本地模型
      ├── config.py     ── 讀寫 config.json
      └── skills.py     ── 讀取 skills/*.md
```

## 從零開始的使用說明

### 先決條件

- **Python 3.10 以上**（開發環境為 3.14）。
- **[Poetry](https://python-poetry.org/)** 用於管理相依套件。
- （選用）**API 金鑰或本地模型**——AI 助理需要其中之一才能回應：
  - 雲端：設定環境變數 `ANTHROPIC_API_KEY`。
  - 本地：執行中的 [Ollama](https://ollama.com) 或任何 OpenAI 相容伺服器。

### 步驟 1 — 取得原始碼

```bash
git clone <this-repo-url>
cd AI_Words
```

### 步驟 2 — 安裝相依套件

```bash
poetry install          # 建立虛擬環境並安裝相依套件
```

### 步驟 3 —（選用）設定 AI 金鑰

若要使用 Anthropic 雲端模型，先設定金鑰：

```bash
# macOS / Linux
export ANTHROPIC_API_KEY=sk-...

# Windows (PowerShell)
$env:ANTHROPIC_API_KEY = "sk-..."
```

若未設定金鑰，App 會自動選用可連線的本地模型，開箱即用。

### 步驟 4 — 啟動

```bash
poetry run ai-words     # 啟動伺服器並在瀏覽器開啟編輯器
```

`poetry run ai-words` 是打包好的進入點；`poetry run python run.py` 效果相同。
App 服務於 `http://127.0.0.1:8765/`。可用選項：

```bash
poetry run ai-words --port 9000     # 使用其他連接埠
poetry run ai-words --no-browser    # 不自動開啟瀏覽器
poetry run ai-words --host 0.0.0.0  # 對外網開放（預設僅本機）
poetry run ai-words --reload        # 原始碼變更時自動重載（開發用）
```

### 用 Docker 啟動（替代方案）

映像採用純 Python 版本（不含 LibreOffice），因此保持精簡：

```bash
docker build -t ai-words .
docker run --rm -p 8765:8765 -e ANTHROPIC_API_KEY=sk-... ai-words
```

接著開啟 `http://127.0.0.1:8765/`。模型／技能狀態存放於 `/data`；掛載具名磁碟區以便跨容器重啟保留：

```bash
docker run --rm -p 8765:8765 -e ANTHROPIC_API_KEY=sk-... -v ai-words-data:/data ai-words
```

若需 LibreOffice 的高保真 ODT 轉換，取消 [`Dockerfile`](Dockerfile) 中 `libreoffice-writer` 區塊的註解即可啟用。

## 設定 AI 模型

首次執行時會建立 `config.json`，內含下列模型後端：

- **Claude Opus 4.8** / **Claude Haiku 4.5** — 透過 Anthropic API。設定環境變數 `ANTHROPIC_API_KEY` 即可使用。
- **本地模型** — 首次執行時若 [Ollama](https://ollama.com) 正在運行，會**一次性探索**其已安裝的模型並加入清單。之後改由你在 UI 明確管理（新增／移除），所以變更會保留。任何 OpenAI 相容伺服器（Ollama、LM Studio…）皆可。

若未設定 API 金鑰，App 會自動選用可連線的本地模型，開箱即用。你可以：

- 從助理面板的下拉選單切換模型，或使用 `/model <id>`。
- 編輯 `config.json`（或呼叫 `POST /api/models`）加入自己的後端。

> 支援會輸出 `<think>…</think>` 的推理模型（qwen、deepseek-r1…）——推理內容會自動從對話顯示中剝除。

## 使用方式

- **開啟（Open）** — 用工具列開啟 `.odt`（或 `.html`）檔，內容會描繪進編輯器。
- **編輯（Edit）** — 直接在左側面板編輯；使用工具列做粗體／斜體／底線、標題與清單。
- **詢問助理（Ask）** — 在右側面板請助理閱讀或編輯文件。當它提出修改時，會回傳整份修訂後的文件；點擊 **Apply to document** 即可套用。
- **儲存（Save）** — 從 Save 選單匯出為 ODT 或 HTML。

助理的斜線指令：

| 指令 | 說明 |
| --- | --- |
| `/help` | 顯示可用指令 |
| `/models` | 列出可用模型 |
| `/model <id>` | 切換至指定模型 |
| `/skills` | 列出技能 |
| `/skill new <name>` | 建立新技能 |
| `/skill load <name>` | 載入技能 |
| `/clear` | 清除對話 |

## 加入 LaTeX 模板

映像檔內建 `texlive-latex-recommended` 與 `texlive-latex-extra`，涵蓋 `article`、`report`、`book`、`beamer` 等約 280 個 class，但**不包含期刊模板**——那些屬於太過龐大、不適合烤進映像檔的套件集。`IEEEtran`、`acmart`、`elsarticle`、`revtex` 都沒有。文件用到這些會編譯失敗，日誌會明確指出缺哪個檔案：

```
! LaTeX Error: File `IEEEtran.cls' not found.
```

不必重建映像檔，把 class 或套件放進 `TEXMFHOME` 即可——容器已將它指向 **`/data/texmf`**，也就是你原本就為了模型與技能而掛載的那個 volume，因此模板會跟其他狀態一起在重啟後留存。`/usr/share/texlive` 底下的系統樹對應用程式的使用者是唯讀的，而 Debian 的 `tlmgr` 也拒絕安裝進去，所以這是唯一的入口。

唯一的規則是檔案必須放在 **`tex/`** 底下的某處。再往下的結構完全自由——`kpathsea` 會遞迴搜尋整棵樹、不限深度——但直接丟在 `texmf/` 根目錄的檔案找不到：

```
/data/texmf/
└── tex/
    └── latex/
        └── ieeetran/
            └── IEEEtran.cls      ✅ 找得到
/data/texmf/
└── IEEEtran.cls                  ❌ 找不到
```

使用具名 volume 時，把檔案複製進去再重啟：

```bash
docker cp IEEEtran.cls $(docker ps -qf ancestor=ai-words):/data/texmf/tex/latex/ieeetran/
```

或改用綁定掛載一個放在主機上的目錄，長期維護比較方便：

```bash
mkdir -p ./ai-words-data/texmf/tex/latex/ieeetran
cp IEEEtran.cls ./ai-words-data/texmf/tex/latex/ieeetran/
docker run --rm -p 8765:8765 -v ./ai-words-data:/data ai-words
```

`.sty` 套件同理，`.bst` 參考文獻樣式與字型檔也是——凡是 `kpathsea` 會查找的都適用。不需要重建索引：`TEXMFHOME` 是即時掃描的，檔案放進去之後下一次編譯就生效，不必重啟。

若不透過 Docker 執行，`TEXMFHOME` 的位置由你的 TeX 發行版決定——Linux 與 macOS 通常是 `~/texmf`，某些設定則是 `~/.texlive/texmf-home`。可以這樣查：

```bash
kpsewhich -var-value=TEXMFHOME
```

如果你希望某個模板不必靠 volume 就人人可用，那就裝進映像檔：在 [`Dockerfile`](Dockerfile) 的 `texlive` 階段加入對應的 TeX Live 套件（`texlive-publishers` 涵蓋 IEEEtran、`elsarticle` 與 `revtex`；`texlive-science` 涵蓋大部分數學與物理相關套件），然後重建。

## 執行測試

```bash
poetry install          # 會一併安裝 dev 群組（pytest）
poetry run pytest
```

測試會把所有外部工具都打樁，因此不需要 AI 金鑰、LibreOffice、LaTeX 引擎或瀏覽器。需要這些的測試會**跳過**而不是失敗，所以直接跑 `pytest` 永遠是綠的。三個 Docker target 分別補上缺的那一塊：

```bash
# 與上面相同的測試，跑在專案指定的 Python 版本上。
docker build --target test -t ai-words-test . && docker run --rm ai-words-test

# 同上，另外具備真正的 LaTeX 引擎（xelatex + CJK 字型）。
docker build --target test-tex -t ai-words-test-tex . && docker run --rm ai-words-test-tex

# 同上，另外具備 Chromium，用於瀏覽器測試。
docker build --target test-ui -t ai-words-test-ui . && docker run --rm ai-words-test-ui
```

`tests/test_latex_engine.py` 會編譯真實文件——交叉引用是否從重用的 `.aux` 解析、壞掉的文件是否回報編譯日誌、CJK 文件是否找得到字型。`PATH` 上沒有引擎時會跳過。

`tests/test_ui.py` 用真正的 Chromium driving 兩個編輯器，因為測試套件裡沒有別的東西看得見版面：它檢查 `/editor` 與 `/latex` 的 AI 區版面完全一致、對話內容可見且輸入框位在底部、分隔條的拖曳與收合在兩頁行為相同。沒裝瀏覽器時會跳過。要在 Docker 之外執行，先抓一次瀏覽器：

```bash
poetry run playwright install chromium
```

這些都不會進到部署映像檔：`runtime` 是從 `builder` 階段複製 virtualenv，而該階段只跑 `--only main`，所以 dev 群組（pytest、Playwright 等）從來不在裡面。

## 打包成單一執行檔

啟動器與網頁 UI 皆無建置步驟，因此可用 PyInstaller 產出單一執行檔：

```bash
pyinstaller --onefile --add-data "app/static:app/static" --name ai_words run.py
```

## 開發藍圖

- [x] 可啟動並提供本地網頁 UI 的執行檔
- [x] 雙面板佈局（編輯器 + AI 助理）
- [x] ODT → HTML 描繪（匯入）
- [x] 瀏覽器內富文字編輯
- [x] HTML → ODT 匯出（儲存）
- [x] 具模型切換的 AI 聊天介面（本地 + API 後端）
- [x] 技能的建立與載入
- [x] 代理驅動的文件讀／寫（提議並套用）
- [ ] **LaTeX 格式寫入支援（進行中）：** 讓文件能匯出 / 寫入 LaTeX 格式。
- [ ] 更高保真度的 ODT 轉換（圖片、樣式、巢狀清單）
- [ ] 即時／工具式編輯，取代整份文件替換
- [ ] **真正的代理框架（進行中）：** 一個代理式工具呼叫迴圈——定義 `read_document` / `apply_edit` 工具，讓模型呼叫、於伺服器端執行並回饋結果，使模型能多步迭代。目前助理是單輪的「提議並套用」（使用者手動接受整份重寫），因此屬於聊天協調層，尚非真正的代理框架。
- [ ] 打包並發布預建執行檔

## 授權

詳見 [LICENSE](LICENSE)。

`app/static/vendor/` 內含 [pdf.js](https://github.com/mozilla/pdf.js)（Mozilla，Apache-2.0），
用於渲染 LaTeX 的 PDF 預覽。
