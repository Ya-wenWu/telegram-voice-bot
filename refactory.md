# 重構計畫

## 1. 總要目標

本專案目前已有可用的語音助理、管理介面、部署診斷與安全防護，但主要邏輯集中在大型檔案中，造成責任重疊、變更風險高、測試困難與新功能開發成本偏高。

本計畫以漸進式重構為原則，分批搬移程式碼，不改變目前對外 API、使用者體驗與啟動流程。

主要目標：

- 將後端巨型 `server.ts`拆成設定、服務、控制器、路由、中介層與啟動入口。
- 將大型 React 元件拆成頁面區塊、功能元件、Hook 與服務。
- 建立明確的模組邊界與單向依賴方向。
- 將第三方 SDK、Python Bridge、檔案系統與網路存取隔離為可替換介面。
- 引入可重複執行的單元、整合與端對端測試。
- 維持 Windows、Linux/macOS 啟動腳本及既有環境檔格式相容。
- 將單檔大小、複雜度與相依方向納入持續檢查。

不在本次重構範圍內：

- 不重寫產品功能。
- 不變更既有 HTTP endpoint、request/response 格式與資料儲存格式。
- 不調整 Gemini、Telegram、Edge-TTS、ffmpeg 與 Python 的既有運作模式。
- 不修正與重構無關的既有功能問題。

## 2. 現況盤點

### 2.1 後端

目前核心進入點為 `server.ts`，約 3,541 行。該檔案同時包含：

- 環境與部署設定偵測。
- Gemini 金鑰與用戶端建立。
- ffmpeg 與 Python Bridge 執行。
- 語音轉文字、文字回覆與語音合成。
- API Guard、管理員驗證、Bot Guard 與速率限制。
- Express application 建立與所有 HTTP routes。
- ZIP、啟動器與前端靜態檔案下載。
- 系統診斷、設定熱更新與日誌。

這會造成以下風險：

- 修改一項功能可能影響無關路由或啟動流程。
- 本地測試需啟動完整伺服器與外部服務。
- 相同設定、驗證或錯誤處理可能重複實作。
- 新人難以判斷哪些函式屬於設定、整合層、業務邏輯或傳輸層。

### 2.2 前端

前端已具備 `components/`、`services/`、`utils/` 與 `types/`，但大型頁面與元件仍可能承擔資料取得、格式轉換、業務判斷與畫面呈現的多重責任。

重點包括：

- `src/App.tsx`負責整體頁面組合。
- `src/components/`包含系統資源、診斷、報表、郵件與 Bot console 等功能區塊。
- `src/services/`已開始區分第三方或資料存取服務。
- 單一元件內的 state、API 呼叫與副作用仍需逐一盤點。

### 2.3 現有驗證能力

`package.json`目前提供：

- `npm run dev`
- `npm run build`
- `npm run lint`
- `npm run doctor`
- `npm run clean`

重構前應補齊：

- 單元測試腳本。
- API 整合測試腳本。
- React 元件測試腳本。
- 測試覆蓋率門檻與 CI 執行方式。

## 3. 重構架構

採用分層式模組架構，Express 負責傳輸層，服務層負責應用流程與業務規則，整合層負責外部系統。

```text
src/
  app/
	App.tsx
	providers/
  features/
	conversation/
	voice-diagnostics/
	system-resources/
	email-delivery/
	github/
  components/
  hooks/
  services/
  types/
  utils/

server/
  config/
  middleware/
  routes/
  controllers/
  services/
  integrations/
  repositories/
  types/
  utils/
  app.ts

server.ts
```

實際命名可依檔案系統與既有慣例調整，但責任分類應維持一致。

建議依賴方向：

```text
入口層 -> 路由層 -> 控制器層 -> 服務層 -> 整合層/Repository
前端頁面 -> 功能 Hooks -> 功能服務 -> API Client
```

禁止：

- route 直接操作 ffmpeg、Python、Gemini SDK 或檔案系統。
- controller 內包含領域規則。
- integration 層直接讀取 Express request/response。
- React component 直接散落第三方 SDK 呼叫。
- 跨模組互相匯入未公開的內部檔案。

## 4. 後端重構方案

### 4.1 啟動入口

將 `server.ts`縮減為啟動職責：

- 載入環境設定。
- 建立 logger 與容器。
- 呼叫 `createApp()`建立 Express application。
- 啟動 HTTP server。
- 設定訊號處理與優雅關閉。

可分離為：

```text
server.ts
server/app.ts
server/container.ts
server/config/environment.ts
```

### 4.2 設定模組

將環境變數、部署模式、路徑與功能開關集中管理。

建議輸出型別：

- `ServerConfig`
- `GeminiConfig`
- `DeploymentConfig`
- `SecurityConfig`
- `PythonBridgeConfig`

設定模組不得包含商業邏輯，並應在啟動時驗證必要欄位。

### 4.3 日誌與錯誤處理

建立共用 logger 與 `AppError`錯誤階層：

- `ValidationError`
- `AuthenticationError`
- `AuthorizationError`
- `NotFoundError`
- `UpstreamTimeoutError`
- `UpstreamUnavailableError`

所有 API 應經由中央錯誤中介層統一回傳：

- HTTP status
- 錯誤 code
- 使用者可讀訊息
- correlation/request ID

不得洩漏金鑰、內部路徑或完整第三方錯誤內容。

### 4.4 Middleware

將以下邏輯獨立：

- 請求紀錄與 timing。
- 本機綁定與雲端部署判斷。
- API Guard。
- Web API bearer token 驗證。
- Admin API token 驗證。
- Bot Guard。
- rate limit。
- 錯誤處理。

每個 middleware 應只負責單一關切，並透過設定注入部署與安全參數。

### 4.5 Routes 與 Controllers

將路由依功能分組：

```text
server/routes/health.routes.ts
server/routes/conversation.routes.ts
server/routes/voice.routes.ts
server/routes/settings.routes.ts
server/routes/download.routes.ts
server/routes/system.routes.ts
server/routes/diagnostics.routes.ts
```

Controller 只負責：

- 讀取參數。
- 呼叫驗證工具。
- 呼叫 application/service。
- 將結果轉為 HTTP response。

Controller 不應直接執行 ffmpeg、Python、檔案讀寫或直接呼叫 SDK。

### 4.6 Conversation Pipeline

保留既有對話流程，但拆分為 use-case 與步驟：

- 輸入轉錄。
- Prompt Guard。
- Conversation memory 查詢。
- Gemini 回覆產生。
- TTS 文字清理。
- 語音合成。
- 回應與記錄寫入。

建議介面：

```text
SpeechTranscriber
ConversationGenerator
SpeechSynthesizer
ConversationStore
PromptGuard
```

可先以 Adapter 包裝現有實作，再逐步替換內部邏輯。

### 4.7 External Integrations

建立獨立整合模組：

```text
server/integrations/gemini/
server/integrations/python-bridge/
server/integrations/ffmpeg/
server/integrations/telegram/
server/integrations/redis/
```

每個整合模組提供應用層可理解的介面，不將 SDK 型別外洩到 controller 或 route。

此階段也應套用：

- Timeout。
- Retry，僅對明確的 transient 錯誤執行。
- Circuit breaker，視運維需求逐步啟用。
- Fail-open/fail-close 的明確設定與記錄。
- Dependency injection，便於替換測試替身。

### 4.8 Filesystem 與 ZIP

將以下功能從 route 移至 service：

- 檔案樹探索。
- 檔案內容讀取。
- ZIP 資料收集。
- 下載檔案的安全路徑驗證。
- 啟動器與 `dist` 檔案輸出。

所有路徑輸出都應先做根目錄限制，避免路徑穿越。

### 4.9 sendFile 修正延續

目前三處 `res.sendFile()`應繼續使用絕對路徑，不使用不支援的 `root`選項：

- 啟動器腳本。
- Linux 啟動腳本。
- `dist/index.html`。

重構後由 Download Service 統一處理。若產品確實需要相對下載檔名與根目錄，可在下載服務內以既有安全封裝處理，不直接把 `root`塞回 Express options。

## 5. 前端重構方案

### 5.1 功能切片

依功能而非元件類型組織程式碼：

```text
src/features/conversation/
src/features/voice-diagnostics/
src/features/system-resources/
src/features/email-delivery/
src/features/compliance/
src/features/github/
src/features/load-test/
```

每個功能可包含：

- page/container
- component
- hook
- service/client
- type
- test

### 5.2 API Client

建立共用 API client，集中處理：

- base URL。
- JSON/content type。
- auth header。
- timeout。
- 統一錯誤格式。
- network retry policy。

領域服務應呼叫 API client，不應直接散落 `fetch()`於多個元件。

### 5.3 Hooks 與 State

將以下邏輯抽取為 Hook：

- polling。
- load/error/retry state。
- 表單狀態。
- polling 取消與清理。
- WebSocket/SSE 連線。
- 設定即時更新。

大型元件應保留畫面組合責任，資料取得與副作用交給 container/hook。

### 5.4 元件拆分規則

每個元件優先符合：

- 單一畫面責任。
- props 明確且最小。
- 不直接處理非 UI 業務規則。
- 不直接呼叫 SDK 或讀取環境設定。
- 可透過 props 或 context 接收依賴。
- 不超過約 300 行；超出時先拆功能區塊再拆工具函式。

可拆成：

- Layout。
- Toolbar。
- Status card。
- Result table。
- Dialog。
- Empty/error/loading state。

### 5.5 Error Boundary

保留 React Error Boundary，但新增：

- 功能區塊級 fallback。
- 非敏感錯誤紀錄。
- 重試或重新載入操作。
- API 錯誤與元件錯誤區分。

## 6. 分階段執行順序

### Phase 0：基準與保護

時間目標：1 至 2 天。

工作：

1. 記錄現有 API endpoint 清單與 request/response。
2. 保存主要使用流程的 smoke test 結果。
3. 補齊缺失套件安裝與乾淨安裝驗證。
4. 建立後端與前端測試環境。
5. 在 CI 先執行 `npm ci`、`npm run lint`與`npm run build`。
6. 建立版本控制分支與重構提交粒度規範。

完成條件：

- 基準測試可重複執行。
- 未重構前已知道主要 API 行為。
- 產生可供後續比對的建置與 lint 結果。

### Phase 1：抽出設定、日誌與共用 Middleware

時間目標：2 至 3 天。

工作：

- 建立 environment/config 模組。
- 建立中央 logger。
- 建立中央 error handler。
- 抽出 auth、guard 與 rate limit middleware。
- 抽出共用路徑與檔案工具。

完成條件：

- `server.ts`不再直接混合設定驗證與 middleware 實作。
- 設定與安全行為可透過單元測試驗證。
- 錯誤回應格式不變。

### Phase 2：抽出 External Integrations

時間目標：3 至 5 天。

工作：

- 建立 Gemini client adapter。
- 建立 ffmpeg executor adapter。
- 建立 Python Bridge client。
- 建立 Redis/Conversation Store adapter。
- 建立 timeout、retry 與錯誤映射。

完成條件：

- 業務服務不直接匯入 SDK 實作細節。
- 可使用 fake/mocked integration 執行單元測試。
- timeout與transient錯誤行為有測試。

### Phase 3：拆分 Express Routes

時間目標：3 至 5 天。

工作：

- 建立 routes 與 controllers。
- 每次搬移一組相依度低的 endpoint。
- 先處理 health、download、diagnostics。
- 再處理 settings、voice 與 conversation。
- 最後處理安全敏感與管理 API。

建議垂直切片順序：

1. `/api/bot/status`
2. 啟動器與靜態檔案下載。
3. 系統與診斷 endpoints。
4. 設定讀取與更新。
5. 語音轉錄與合成。
6. conversation pipeline。

完成條件：

- 每組 route 能獨立測試。
- endpoint response 與 HTTP status 保持相容。
- `server.ts`只負責組裝 application。

### Phase 4：拆分 Conversation Pipeline

時間目標：4 至 7 天。

工作：

- 抽出 transcription service。
- 抽出 Gemini reply service。
- 抽出 TTS service。
- 抽出 conversation orchestration service。
- 抽出 memory repository。
- 抽出 prompt guard。

完成條件：

- 可以只測 pipeline 的某一步。
- 外部服務失敗有明確結果與對應 HTTP 錯誤。
- 音訊格式與模型設定行為保持相容。

### Phase 5：重構前端功能模組

時間目標：4 至 7 天。

工作：

- 建立共用 API client。
- 建立功能區域與自訂 Hooks。
- 抽取 polling、retry 與錯誤處理。
- 把大型元件拆成 container 與 presentational component。
- 建立元件與 Hook 測試。

建議優先處理：

1. System Resources。
2. Voice Diagnostics。
3. Load Test Report。
4. Email Delivery。
5. Bot Console。
6. `App.tsx`整體組裝。

完成條件：

- 元件不直接實作重複 API 邏輯。
- polling 與取消行為可測試。
- UI loading/error/empty state 一致。

### Phase 6：清理、規範與持續改善

時間目標：2 至 4 天。

工作：

- 移除未使用匯入與死碼。
- 統一檔案與資料夾命名。
- 補齊公開介面的型別。
- 建立模組 README 與範例。
- 設定 coverage 門檻。
- 設定檔案大小與依賴規則。
- 執行完整回歸與效能 smoke test。

完成條件：

- 無循環相依。
- 無同一責任重複實作。
- 啟動、建置、lint 與測試可重複執行。

## 7. 建議設計模式

### Service/Use-Case Pattern

適用於：

- conversation pipeline。
- transcription。
- TTS。
- 檔案下載。
- 診斷與環境檢查。

每個 use-case 只處理一個具體目標，不包含 HTTP 或 React UI 細節。

### Repository Pattern

適用於：

- conversation memory。
- 設定儲存。
- Redis 操作。
- 本地檔案存取。

service 不應直接知道底層儲存是記憶體、檔案或 Redis。

### Adapter Pattern

適用於：

- Gemini SDK。
- Telegram SDK。
- Firebase。
- Python Bridge。
- ffmpeg。
- JSZip。

Adapter 應將外部型別轉成專案內部型別。

### Dependency Injection

初期可採用簡單工廠或 container，不必立即引入大型 DI 框架。

範例責任：

- 生命週期建立。
- 相依性組裝。
- 測試替身注入。
- 避免整個檔案直接建立 SDK client。

### Strategy Pattern

適用於：

- 不同 TTS provider。
- 不同 deployment profile。
- 不同 storage provider。
- 不同平台啟動器下載。

### Factory Pattern

適用於：

- 建立 Gemini client。
- 建立 Python Bridge client。
- 建立不同部署設定。
- 建立 Express application。

### Result/Typed Error Pattern

對預期可控的錯誤，使用 Typed Error 或 Result 型別，而不是把所有錯誤轉成字串。

非預期錯誤仍交由中央錯誤處理；不得吞掉或用假成功回應。

### Central Error Handling

適用於 Express 與前端：

- 後端統一轉換錯誤為 HTTP response。
- 前端統一轉換 API 錯誤為 UI 狀態。
- 日誌保留足夠除錯資訊，但不得洩漏敏感內容。

## 8. 測試策略

### 8.1 單元測試

測試：

- Prompt Guard。
- 錯誤分類。
- 音訊檔名與 MIME 類型判斷。
- 速率限制與安全驗證。
- 設定解析。
- 路徑安全與 ZIP 檔案收集。
- 純 React formatter/helper。

外部 SDK、ffmpeg、Python 與網路呼叫應使用 mock/fake。

### 8.2 API 整合測試

使用 Express app 加入測試用依賴，不啟動任意外部程序。

至少測試：

- 正常回應。
- 驗證失敗。
- 未授權。
- upstream timeout。
- upstream unavailable。
- invalid bot id。
- invalid/unsafe path。
- Content-Disposition 與下載檔案。
- 靜態頁面 fallback。

### 8.3 React 測試

至少測試：

- loading state。
- success state。
- error/retry state。
- polling 清理。
- Dialog 開關。
- 資料格式與空資料。

### 8.4 E2E Smoke Test

保留以下主要流程：

- 啟動伺服器。
- 開啟首頁。
- 查詢 bot status。
- 載入診斷資料。
- 文字對話。
- 語音錄製與上傳。
- 啟動器下載。
- 下載完整專案 ZIP。

外部 Gemini/Telegram API 不需在所有單元與整合測試中實際呼叫。

## 9. 品質門檻

建議加入以下規則：

- 單檔 TypeScript/TSX 建議不超過 400 行；超過時需拆分。
- 單一函式建議不超過 50 行；超出時需抽出命名清楚的步驟。
- Controller 不直接呼叫 SDK。
- Route 不包含超過輸入驗證與服務呼叫以外的業務邏輯。
- 單一模組對外匯出 index/barrel 或公開介面，避免跨模組深層匯入。
- 禁止服務層匯入 Express、React 或瀏覽器 API。
- 禁止整合層匯入 controller、route 或 UI。
- 新功能不得繼續在 `server.ts`或`App.tsx`新增主要邏輯。
- 核心 use-case 建議測試覆蓋率 80%以上。
- 外部整合至少保留 mock/fake 與一次 smoke test。

建議工具：

- TypeScript strict mode。
- ESLint。
- Prettier。
- Vitest。
- React Testing Library。
- Supertest。
- 依賴巡檢工具或 ESLint import boundary rule。
- CI 執行 lint、test、build 與 doctor。

## 10. 驗收條件

重構完成後應符合：

1. `server.ts`僅負責啟動與 application 組裝。
2. 所有 HTTP endpoint 被規劃到對應 route/controller。
3. Gemini、Python、ffmpeg、Telegram 與 Redis 均透過 adapter/accessor 隔離。
4. 路徑、金鑰、啟動器、設定與安全邏輯沒有散落在 route 中。
5. `App.tsx`與大型元件不再承擔重複 API/data orchestration。
6. 單元、整合與 E2E smoke test 可重複執行。
7. 現有 Windows/Linux 啟動流程不變。
8. 現有 API request/response 相容或有明確版本化與 migration。
9. `npm run lint`與`npm run build`通過。
10. `npm run doctor`仍能正確診斷環境。
11. 已記錄每個功能模組的責任、主要介面與測試方式。
12. 沒有新增或暴露敏感金鑰、內部密鑰或個人設定。

## 11. 建議執行順序摘要

| 順序 | 工作項目 | 預期風險 | 驗證方式 |
| :--- | :--- | :--- | :--- |
| 1 | 建立測試與 CI 基準 | 中；可能暴露既有問題 | lint、build、smoke test |
| 2 | 抽出 config、logger、error middleware | 中；路徑與設定容易錯置 | 單元與 server 啟動測試 |
| 3 | 抽出 auth、guard、rate limit | 高；會影響安全行為 | 安全與拒絕路徑測試 |
| 4 | 抽出外部 SDK adapters | 中；可能需 mock | integration 單元測試 |
| 5 | 按 endpoint 類別拆 routes/controllers | 中；路由順序易受影響 | API 整合測試 |
| 6 | 拆分 conversation pipeline | 高；會影響語音與回覆品質 | 音訊流程與 timeout 測試 |
| 7 | 重構前端功能切片 | 中；state/polling 易遺漏 | 元件與 E2E 測試 |
| 8 | 清理與規範治理 | 低；需防止過度抽象 | lint、coverage、code review |

## 12. 重構完成定義

重構不是只把程式碼搬到更多資料夾，而是要達成：

- 變更能落在單一明確模組。
- 主要流程能在不啟動真實 Gemini/Telegram/ffmpeg 的情況下測試。
- 第三方依賴不透過整個程式碼庫傳遞。
- 入口檔案只負責組裝與啟動。
- 新功能優先放入功能模組，而不是持續追加到巨型檔案。
- 重構後的程式碼比重構前更容易理解、測試與維運。
