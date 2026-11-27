# 規格：Telegram Voice Bot 後台管理系統

Nov 19, 2026 · @Alicia.W

## 背景與目標

後台讓管理者在網頁上修改 Telegram Voice Bot 的設定，改完不必重啟 bot 就能生效（對應 issue #22）。

現況：`bot/config.py` 在啟動時一次讀入環境變數，其他模組又各自複製這些值（例如 `handlers.py` 直接匯入 `ALLOWED_USER_IDS`），所以任何設定變更都得重啟。

目標：

- 管理者能用網頁檢視與修改可即時生效的設定。
- Python bot 維持為核心，不重寫。
- 所有服務能在同一台 1 GB RAM、單核的 Debian 主機上同時運作。

## 範圍與非目標

本規格只涵蓋「用網頁管理 Python bot 的設定」這一階段。

包含：

- ASP.NET Core 後台：登入、檢視與修改設定。
- 共用設定儲存，以及 Python bot 端的設定讀取與重新載入。
- 對話記憶（對應 #26），因為它需要可調整的設定。

不包含：

- 用 Blazor 網頁取代 Telegram 作為使用者端的輸入輸出介面，列為之後的獨立階段，另開 issue。
- 重寫 Python bot。
- 讓 bot 改呼叫本機的 opencode（決策見「LLM 提供者決策與對話記憶」）。

## 部署環境與記憶體預算

目標主機是 1 GB RAM、單核的 Debian，同一台機器上要同時運作五樣東西，記憶體是最緊的限制。下表的數字是估計值，尚未實測。

| 項目 | 運作方式 | 粗估占用 | 備註 |
| --- | --- | --- | --- |
| Debian 本身 | 系統 | 100–150 MB | 保持精簡，不跑不必要的服務 |
| Python bot | 主機上的行程 | 100–200 MB | 處理語音時 ffmpeg 會短暫增加 |
| ASP.NET Core 後台 | 主機上的行程 | 80–200 MB | 取決於 GC 設定與連線數 |
| Redis | Docker 容器 | 10–60 MB | 另加 Docker 常駐服務約 50–100 MB |
| opencode | 主機上的行程 | 未知 | 用量需實測，bot 不依賴它 |

管控原則：

- 每個服務在 systemd 設定 `MemoryHigh` 與 `MemoryMax`，數值待實測後校準。
- .NET 明確使用 workstation GC 並設堆積上限（`DOTNET_gcServer=0`、`DOTNET_GCHeapHardLimit`）。
- Redis 容器設 `--memory`，Redis 自己設更小的 `maxmemory` 並指定淘汰策略，不使用預設的 `noeviction`。
- 主機啟用 swap 或 zram，避免短暫尖峰直接觸發 OOM。
- 不在這台主機上編譯 .NET，改在別處 `dotnet publish` 後再部署。
- 若 Docker 只拿來跑 Redis，可評估改用 apt 安裝的 Redis 或 SQLite 以省下 Docker 的常駐記憶體。

實測方式：在主機上執行 `free -m`、`swapon --show`、`ps -eo pid,rss,comm --sort=-rss | head -15`，用實際數字取代上表的估計。

## 設定項目與生效方式

設定分三類，後台要分開處理。

| 類別 | 設定項目 | 生效方式 |
| --- | --- | --- |
| 即時生效 | `ALLOWED_USER_IDS`、`DAILY_REQUEST_LIMIT`、`ZEN_MODEL`、`WHISPER_MODEL`、`WHISPER_LANGUAGE`、`TTS_VOICE`、system prompt、對話記憶輪數 | 後台寫入共用儲存，bot 在使用時讀取 |
| 必須重啟 | `TELEGRAM_BOT_TOKEN`、`BOT_WORKERS`、`CONCURRENT_UPDATES` | 後台可修改，但需提示並由管理者重啟 bot |
| 金鑰類 | `ZEN_API_KEY`、`WHISPER_API_KEY`、`TELEGRAM_BOT_TOKEN` | 後台只能寫入或更換，永不顯示現有的值 |

Python 端要做的改動：

1. 把 `bot/config.py` 的模組層級常數改成設定物件，各模組在每次使用時才取值，不再用 `from bot.config import X` 複製。
2. `opencode_client.py` 的認證標頭改成每次請求時組合，不在 import 時固定。
3. 設定來源的優先順序：共用儲存，其次 `.env`，最後程式內建預設值。
4. system prompt 目前寫死在 `build_system_prompt()`（內容是「協助 C# .NET 學習者」），改為可在後台設定，預設值保持現狀。

## 安全性

後台能改白名單與金鑰，等於握有 bot 的控制權，所以保護重點是登入、金鑰和網路邊界。

- **後台認證：** 所有 `/admin` 路由都要登入。使用 Cookie 驗證（HttpOnly、Secure、SameSite），初始管理員帳密由環境變數在首次啟動時帶入，密碼只存雜湊。
- **金鑰：** 後台永遠不回傳現有金鑰的值，也不寫進日誌；儲存時不使用明文。
- **白名單 fail-closed：** 讀不到設定時沿用上一次成功讀到的值，或退回 `.env`，絕不因此變成「所有人都允許」。
- **Redis（Docker）：** port 只發布到本機（`-p 127.0.0.1:6379:6379`），不可用 `-p 6379:6379`，因為 Docker 發布 port 會繞過一般防火牆設定；並設定 `requirepass`。
- **opencode 同機隔離：** opencode 會保存憑證並能執行工具，應與 bot 和後台使用不同的系統使用者，並用 systemd 沙盒參數隔離；若它有開 `serve` 的 port，只綁 `127.0.0.1`。
- **bot 的 `.env`：** 維持 `chmod 600`。
- **後台對外：** 只在需要時開放，建議放在反向代理與 TLS 之後，或只允許內網或 VPN 存取。

### 現行網頁服務（Node/Express）的存取控制

在 ASP.NET Core 後台完成之前，現有的 Web Voice Bot（`server.ts`）是對外唯一的 HTTP 入口，它同樣能改白名單、跑測試、下載原始碼，所以適用同一個原則：**預設只信任本機，遠端一律要憑證**。

**判定規則（`enforceNetworkAuth`）**

| 條件 | 結果 |
| --- | --- |
| 有設定 `WEB_API_TOKEN` | 所有受保護路由都必須帶 `Authorization: Bearer <token>`，缺少或錯誤回 `401` |
| 沒設定，且是**直接的**本機連線（127.0.0.1／::1，且不帶轉發標頭） | 放行 |
| 沒設定，其餘情況（遠端、經反向代理轉入） | 回 `403` |

- **沒有「雲端環境」例外。** 先前 `K_SERVICE`、`APP_URL` 判定為雲端時會略過拒絕，已移除；公開網址同樣需要 token。
- **反向代理不算本機。** 同一台機器上的 nginx、Caddy 也是從 127.0.0.1 連入。只要請求帶 `X-Forwarded-For`、`X-Forwarded-Host`、`X-Forwarded-Proto`、`X-Real-IP` 或 `Forwarded` 任一標頭，就視為遠端。
- **比較 token 用常數時間比對**（`timingSafeEqual`）。
- 非本機位址監聽卻沒設 `WEB_API_TOKEN` 時，啟動會印出 ERROR 日誌。

**路由分級**

| 類別 | 路徑 | 保護 |
| --- | --- | --- |
| 公開 | `/health`、`/ready`、前端靜態檔案 | 無（供負載平衡器與健康檢查，不含機密） |
| 受保護（網路層） | `/metrics`、`/api/observability/*`、`/api/compliance/*`、`/api/download/*`、`/web-voice-bot-complete.zip` | `requireNetworkAuth` |
| 受保護（網路層＋應用層） | `/api/bot/*` | `requireApiGuard`（網路層＋800 ms POST 防抖），再加 BotGuard |
| 額外管理權杖 | `/api/bot/config`、`/api/bot/run-tests`、`/api/bot/bots` 的寫入、供應鏈檢查清單 | 有設 `ADMIN_API_TOKEN` 時另需管理權杖 |

**BotGuard 不是身分驗證。** 它判斷的是「像不像機器人」（誘捕欄位、自動化 User-Agent、請求節奏、重複內容），通過方式是解 SHA-256 工作量證明或人機題，任何人都能解。它補強 `WEB_API_TOKEN`，不能取代它。曾實測：雲端模式、未設 token 時，解開 PoW 後即可改寫 `ALLOWED_USER_IDS`。

**前端行為。** 瀏覽器會在受保護的同源請求自動帶上 token（`src/services/apiAuth.ts` 包裝 `fetch`，只處理同源路徑，不會送往 GitHub 或 Google）；收到 `401`，或訊息指出需要 `WEB_API_TOKEN` 的 `403`，就跳出輸入視窗。Token 存在 `sessionStorage`，關閉分頁即清除。

**ASP.NET Core 後台沿用同一份邊界。** 後台與 Blazor 客戶端上線後，上表的「受保護」路徑改由後台的登入機制取代 `WEB_API_TOKEN`，但「遠端一律要憑證、轉發標頭不算本機、`/health` 與 `/ready` 之外不公開」這三條不變。

## 失效處理

bot 不能因為後台或 Redis 出問題而停擺，也不能因此放寬權限。

| 狀況 | bot 的行為 |
| --- | --- |
| 後台掛掉 | bot 照常運作，使用共用儲存裡現有的設定，只是暫時無法修改 |
| Redis 暫時連不上 | 使用記憶體中上一次成功讀到的設定，沒有則退回 `.env` |
| 每日額度檢查失敗 | 維持現有行為：放行並記錄警告（fail-open），30 秒冷卻後再試 |
| 白名單讀取失敗 | 沿用上一次成功的白名單；沒有則退回 `.env`；仍為空則全部拒絕 |
| 設定值格式錯誤 | 忽略該筆並記錄警告，保留舊值，不讓 bot 崩潰 |

額度採 fail-open、白名單採 fail-closed，兩者刻意不同：額度出錯只是少算次數，白名單出錯則是權限問題。

## LLM 提供者決策與對話記憶

決策：bot 繼續呼叫遠端 OpenCode Zen，不改接本機的 opencode。

理由：

- 模型在遠端執行，不占這台 1 GB 主機的記憶體。
- 只回傳文字，沒有工具能在伺服器上執行指令，白名單被突破時風險較小。
- 現有程式已是這種做法，不必重寫。

接受的代價：依賴外部服務與預設的免費層級模型（沒有穩定性保證，額度或模型可能變動）；沒有 opencode 的工具與 AGENTS.md 能力。若日後需要這些能力，另案評估，並先把工具權限收到最小。

對話記憶（#26）補在 bot 側：

- 以 Redis 保存每位使用者最近 N 輪對話，並設存活時間（TTL），送請求時一起帶上。
- N、TTL 與總長度上限都做成後台可調的設定，避免 token 與記憶體無限增加。
- 對話內容屬於個人資料，保存期限要在後台明示，並提供清除功能。

提供者抽象（#25）：把 LLM 與 TTS 各包成一個介面，現在只實作 Zen 與 edge-tts，日後換成其他提供者時不需改動 `WorkerPool` 的主流程。

本機的 opencode 若是個人開發用，可保留，但不應為了 bot 而常駐占用記憶體。

## 實作階段與工作清單

依序進行，前一階段通過驗收再做下一階段。

**階段 0：量測基準**

- [ ] 在目標主機執行三個量測指令，取得各行程實際 RSS 與 swap 狀況。
- [ ] 用實測數字更新「部署環境與記憶體預算」，決定是否保留 Docker 跑 Redis。

**階段 1：Python 端設定層**

- [ ] 將 `bot/config.py` 改成設定物件，各模組使用時才取值。
- [ ] 實作共用儲存的讀取、快取與定期重新載入（失效時依「失效處理」表）。
- [ ] 把 system prompt 改為可設定。
- [ ] 補測試：白名單 fail-closed、設定格式錯誤、Redis 斷線。

**階段 2：ASP.NET Core 後台**

- [ ] 建立專案，Cookie 驗證與密碼雜湊，保護 `/admin` 路由。
- [ ] 設定檢視與修改頁面，金鑰欄位只能寫入。
- [ ] 記憶體限制：workstation GC、堆積上限、systemd `MemoryHigh` 與 `MemoryMax`。

**階段 3：對話記憶**

- [ ] 在 Redis 保存每位使用者最近 N 輪，含 TTL 與長度上限，並提供清除功能。
- [ ] N、TTL、長度上限接到後台設定。

**階段 4：部署與驗證**

- [ ] 在別處 `dotnet publish`，將產出部署到主機。
- [ ] Redis 容器只綁本機並設 `requirepass`，加上 `--memory` 與 `maxmemory`。
- [ ] 依驗收標準逐項驗證。

## 驗收標準

- [ ] **熱重載：** 在後台修改白名單、模型或 system prompt 後，不重啟 bot，下一則訊息就使用新設定。
- [ ] **登入保護：** 未登入存取 `/admin` 會被導向登入頁。
- [ ] **金鑰不外洩：** 後台頁面、回應與日誌中看不到任何現有金鑰的值。
- [ ] **白名單 fail-closed：** 中斷 Redis 後，原本不在白名單的使用者仍被拒絕，原本在白名單的使用者仍可使用。
- [ ] **後台掛掉不影響 bot：** 停止後台服務，bot 的文字與語音功能照常。
- [ ] **記憶體：** 三個服務加 Redis 同時運作並處理一則語音回覆時，主機沒有觸發 OOM，swap 使用量維持在實測後訂出的上限內。
- [ ] **Redis 邊界：** 從主機外部連不上 Redis 的 6379 port。
- [ ] **對話記憶：** 連續追問時 bot 能參照前文；超過設定的輪數或 TTL 後會遺忘；清除功能生效。
- [ ] **非公開路由全部受保護：** 沒設 `WEB_API_TOKEN` 時，從非本機位址（含雲端模式）請求 `/metrics`、`/api/observability/*`、`/api/compliance/*`、`/api/download/*`、`/web-voice-bot-complete.zip`、`/api/bot/*`，都回 `401` 或 `403`；只有 `/health` 與 `/ready` 能存取。
- [ ] **反向代理不被當成本機：** 從 127.0.0.1 發出但帶 `X-Forwarded-For`（或 `Forwarded`、`X-Real-IP`、`X-Forwarded-Proto`）的請求，在沒設 token 時回 `403`。
- [ ] **有 token 才放行：** 設定 `WEB_API_TOKEN` 後，不帶或帶錯 token 回 `401`；帶正確 token 的受保護路由回 `200`（`/api/bot/*` 另需通過 BotGuard）。
- [ ] **本機使用不受影響：** 不設 token、直接用 `http://localhost` 開啟網頁，不出現輸入視窗，所有面板正常載入。
- [ ] **Token 不外送：** 網頁對 `api.github.com` 等其他網域發出的請求不帶 `Authorization` 標頭。
- [ ] **既有品質門檻：** `pytest`、`ruff check`、`ruff format --check`、`mypy` 全部通過。

## 待確認事項與風險

待確認：

- [ ] 共用設定儲存要用 Redis 還是 SQLite？Redis 已在運作，但跑在 Docker 裡會多占記憶體。
- [ ] bot 狀態、佇列與日誌的檢視（#22 的 FR-02）是否納入這一階段？
- [ ] 後台要對外開放，還是只限內網或 VPN 存取？
- [ ] 主機規格統一以 1 GB 為準嗎？目前 README 與 issue #24 寫的是 1.4 GiB。
- [ ] 對話記憶預設保存幾輪、多久？

風險：

- **記憶體不足：** 五樣服務共用 1 GB，估計值未實測，可能比預期更緊。對策是階段 0 先量測，必要時移除 Docker 或調整服務。
- **BotGuard 的 IP 判斷可被偽造：** `getClientIp()` 無條件採用請求帶的 `X-Forwarded-For` 第一個值，BotGuard 以它做追蹤與隔離，攻擊者每次換一個假 IP 就能繞過節流與隔離。需要「只信任已知代理」的設定（例如 Express `trust proxy`）後才能修，尚未處理。
- **雲端部署的行為變更：** 沒設 `WEB_API_TOKEN` 的雲端或 AI Studio 部署，除 `/health`、`/ready` 外全部回 `403`，必須設定 token。同機反向代理對外時亦同。
- **後台是高價值目標：** 它能改白名單與金鑰，認證或網路邊界出錯等於交出 bot 控制權。
- **對話內容是個人資料：** 存進 Redis 後要有保存期限與清除機制。
- **issue #22 原文需更新：** 它寫的是 ASP.NET Core 內含 Telegram worker 並用 `IOptionsMonitor`，與「Python bot 為核心」不符，本規格確認後應取代它。
- **與開啟中的 PR 衝突：** PR #28 與 #31 都修改 `README.md` 與 `.env.example`，先合併其中一個後，另一個可能要處理衝突。

