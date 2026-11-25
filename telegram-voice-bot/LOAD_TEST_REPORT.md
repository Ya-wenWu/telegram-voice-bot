# 系統壓力測試與瓶頸分析報告（Load Test Report）

本報告使用 **Locust 2.47.0** 對 `telegram-voice-bot` 核心管線（真實 `WorkerPool`、真實 `ffmpeg` 音訊拼接、真實 `redis_client` 配額檢查與 Prometheus 指標採集）以及 **Express Web Voice Bot** 實機 HTTP 端點執行多場景壓測，精準量化純文字、純語音、混合負載下的吞吐量、延遲分佈、佇列深度演變與瓶頸來源。

---

## 1. 測試環境與壓測架構

### 1.1 硬體與執行環境（實測規格）

| 項目 | 規格 / 版本 |
| :--- | :--- |
| CPU | 2 vCPU (`x86_64`) |
| 記憶體 | 4,096 MB RAM |
| 作業系統 / 沙箱 | Linux 4.19 (gVisor container) |
| Python 執行環境 | Python 3.11.2（`/opt/bot-venv`） |
| Node.js 執行環境 | Node.js v22.23.2（Express 4 + Vite 8） |
| 音訊工具 | `ffmpeg 4.4.2`（`libmp3lame`） |
| 壓測工具 | Locust 2.47.0（headless CSV 統計）+ `psutil` 資源採樣（每 0.5 秒） |

### 1.2 壓測架構與校準設計

為了避免直接以 12–20 個併發用戶轟炸外部 Gemini / Edge-TTS 免費層而立即觸發第三方 429 限流、掩蓋系統內部瓶頸，壓測分為兩層互補驗證：

1. **核心管線壓測（`loadtest/benchmark_server.py` + `loadtest/locustfile.py`）**：
   - 掛載真實的 `bot.worker.WorkerPool`、`bot.worker._concat_mp3`（呼叫真實 `ffmpeg -threads 1 -c:a libmp3lame -q:a 4` 拼接 3 段真實 0.6s MP3 音檔）、真實 `bot.redis_client.check_daily_quota`（無 Redis 時觸發 Fail-Open 熔斷），以及真實 `bot.observability.metrics`。
   - 外部網路呼叫校準為可控常數以隔離內部排隊與併發瓶頸：`LLM = 120 ms`（分 3 句串流）、`STT = 100 ms`、`TTS = 150 ms / 句`。
   - 每個虛擬用戶（Locust `BotLoadUser`）請求間隔 `wait_time = between(0.05, 0.15)` 秒。
2. **實機 Express 端點與上游延遲校準（`http://127.0.0.1:3000`）**：
   - 使用 Locust 對實機 `/health`、`/ready`、`/metrics` 進行 20 併發 HTTP 壓測。
   - 單次實測 `POST /api/bot/chat` 真實 Gemini LLM + Edge-TTS 端到端耗時，以及單獨微基準測試 `python3 bot_bridge.py status` 與 `ffmpeg` 重編碼 vs `-c copy` 的耗時差異。

### 1.3 可重現執行指令

```bash
# 完整自動化壓測套件（依序執行 S1 / S2 / S3 / S2b / S3b / S4）
python telegram-voice-bot/loadtest/run_suite.py

# 或手動啟動壓測伺服器並個別執行 Locust 場景
python telegram-voice-bot/loadtest/benchmark_server.py --port 8787 --workers 1 --queue-size 10
SCENARIO=text  locust -f telegram-voice-bot/loadtest/locustfile.py --headless -u 10 -r 5 -t 12s --host http://127.0.0.1:8787
SCENARIO=voice locust -f telegram-voice-bot/loadtest/locustfile.py --headless -u 10 -r 5 -t 12s --host http://127.0.0.1:8787
SCENARIO=mixed locust -f telegram-voice-bot/loadtest/locustfile.py --headless -u 12 -r 4 -t 15s --host http://127.0.0.1:8787
```

---

## 2. 壓測場景與實測數據

### 2.1 三大核心場景總覽（預設配置：`BOT_WORKERS=1, BOT_QUEUE_MAXSIZE=10`）

| 場景 | 併發 / 時長 | 總請求 | 失敗數（429 QueueFull） | 總 QPS（有效成功 QPS） | Avg 延遲 | P50 延遲 | P95 延遲 | P99 延遲 | Max 延遲 | Peak `queue_depth` | Peak CPU / RSS |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--- |
| **S1 純文字** | 10u / 12s | 87 | 0（0.0%） | **7.95**（7.95） | 1,043.2 ms | 1,100 ms | 1,200 ms | 1,200 ms | 1,210.6 ms | 9（均 7.00） | 15.9% / 68.4 MB |
| **S2 純語音** | 10u / 12s | 21 | 0（0.0%） | **1.98**（1.98） | 3,732.4 ms | 4,600 ms | 4,900 ms | 5,000 ms | 4,985.8 ms | 9（均 7.64） | 9.9% / 71.4 MB |
| **S3 混合 60%文/40%音** | 12u / 15s | 188 | **154（81.9%）** | 13.42（**僅 2.43**） | 628.7 ms\* | 7 ms\* | **3,800 ms** | **4,000 ms** | 4,290.8 ms | **10（滿載，均 9.52）** | 37.8% / 74.5 MB |

> \* **S3 延遲解讀注意**：S3 因為 12 併發超過 `1 worker + 10 queue = 11` 的容納上限，**81.9% 的請求在入隊檢查即被 `HTTP 429 QueueFull` 快速拒絕（約 7–8 ms）**，拉低了表觀 Avg/P50；**實際成功完成的請求（僅 34 筆：17 文字 + 17 語音）P95 達 3,500–3,800 ms、P99 達 3,900–4,300 ms**。

#### 場景 1：純文字請求（`S1_text_only_w1_q10`）
- **吞吐量**：**7.95 req/s**。以單 Worker + 120 ms LLM 計算，理論極限為 `1000 / 120 = 8.33 req/s`，實測達到理論上限的 **95.4%**。
- **延遲構成**：單次處理僅 ~120 ms，但 10 併發在單 Worker 下形成 1 執行 + 8~9 排隊（平均 `queue_depth = 7.0`），依 Little's Law `W = L / λ ≈ 8.5 / 7.95 ≈ 1.07s`，精準對應實測 P50 **1,100 ms**、P95 **1,200 ms**。
- **資源與 Redis**：Peak CPU 僅 **15.9%**、RSS **68.42 MB**；`redis_failures_total = 4`（初始併發撞擊後立即進入 30 秒 Fail-Open 熔斷，後續零額外開銷）。

#### 場景 2：純語音請求（`S2_voice_only_w1_q10`）
- **吞吐量**：**1.98 req/s**（僅為純文字的 **24.9%**，下降 **4.0×**）。單筆語音端到端工作時間約 `STT 100ms + LLM 120ms（與 3 句 TTS 150ms 管線重疊）+ 真實 ffmpeg 重編碼 ~110–150ms ≈ 500 ms`。
- **延遲**：Avg **3,732.4 ms** | P50 **4,600 ms** | P95 **4,900 ms** | P99 **5,000 ms** | Max **4,985.8 ms**。
- **TTS 排隊與等待時間（`tts_wait_seconds`）**：
  - 總計呼叫 69 次 TTS：Avg **151.47 ms** | P50 **175.0 ms** | P95 **242.5 ms**。
  - 在 `BOT_WORKERS=1` 時，單 Worker 最多同時發出 3 句 TTS，剛好等於 `TTS_CONCURRENCY=3`，因此此階段 **TTS 信號量尚未產生排隊爭用**（`avg 151.47ms ≈ 150ms` 基準耗時）。
- **資源**：Peak CPU 僅 **9.9%**、RSS **71.43 MB**，`ffmpeg_queue_max = 1`。

#### 場景 3：混合負載 60% 文字 + 40% 語音（`S3_mixed_60t_40v_w1_q10`）
- **分端點表現**：
  - `POST /simulate/text`：107 筆請求，**90 筆被 429 拒絕（84.1% 失敗）**，僅 17 筆成功；成功請求受語音任務隊頭阻塞（Head-of-Line Blocking），P95 飆升至 **3,500 ms**、P99 **3,900 ms**（比純文字場景惡化 **3.25×**）。
  - `POST /simulate/voice`：81 筆請求，**64 筆被 429 拒絕（79.0% 失敗）**，僅 17 筆成功；P95 **3,800 ms**、P99 **4,300 ms**。
- **佇列深度（`queue_depth`）與 `ffmpeg_queue_length` 時間序列變化（每 0.5 秒採樣）**：

```text
t (s)  | queue_depth (max=10)       | ffmpeg_q | 狀態說明
-------+----------------------------+----------+-----------------------------
 0.0   |                            | 0        | 壓測啟動
 0.5   | ███████ (7)                | 0        | 4 users 進場，佇列迅速攀升
 1.0   | ██████████ (10)            | 0        | 僅 1.0 秒即打滿上限（QueueFull 開始）
 1.5   | █████████ (9)              | 0        | 單 Worker 消化 1 筆立即再填滿
 2.0   | ██████████ (10)            | 0        | 持續滿載，/ready 進入 503
 3.0   | ██████████ (10)            | 0        | 持續滿載
 4.0   | ██████████ (10)            | 0        | 持續滿載
 5.0   | ██████████ (10)            | 1        | ffmpeg 執行中 + 佇列持續鎖死在 10
 6.5   | ██████████ (10)            | 1        | 持續滿載，429 拒絕風暴
 8.1   | ██████████ (10)            | 0        | 持續滿載
10.1   | ██████████ (10)            | 0        | 持續滿載
11.1   | ██████████ (10)            | 1        | 持續滿載
13.1   | ██████████ (10)            | 0        | 持續滿載
14.6   | █████████ (9)              | 0        | 壓測尾聲仍處於飽和邊緣
15.1   | ██████████ (10)            | 1        | 累計 159 次 QueueFull 拒絕
```

---

### 2.2 瓶頸隔離對照實驗：`BOT_WORKERS=1, Q=10` vs `BOT_WORKERS=3, Q=30`

為了驗證單 Worker 是否為首要瓶頸，並觀察解除單 Worker 限制後下一個瓶頸出現在何處，我們將 `BOT_WORKERS` 提升至 **3**、`BOT_QUEUE_MAXSIZE` 提升至 **30**，重跑相同併發的純語音（`S2b`）與混合負載（`S3b`）：

| 指標 | S2 純語音 (`W=1, Q=10`) | S2b 純語音 (`W=3, Q=30`) | 變化幅度 | S3 混合 (`W=1, Q=10`) | S3b 混合 (`W=3, Q=30`) | 變化幅度 |
| :--- | ---: | ---: | :--- | ---: | ---: | :--- |
| 有效成功 QPS | 1.98 req/s | **5.89 req/s** | **+197.5%（2.97×）** | 2.43 req/s | **9.70 req/s** | **+299.2%（4.0×）** |
| 失敗率（429） | 0.0% | 0.0% | 持平 | **81.9%**（154/188） | **0.0%**（0/136） | **歸零** |
| 整體 P50 延遲 | 4,600 ms | **1,500 ms** | **-67.4%** | —（被 429 污染） | **1,000 ms**（文 870 / 音 1,400） | 恢復可控 |
| 整體 P95 延遲 | 4,900 ms | **1,600 ms** | **-67.3%** | 3,800 ms | **1,600 ms**（文 1,300 / 音 1,700） | **-57.9%** |
| `queue_depth` 峰值 / 均值 | 9 / 7.64 | **7 / 5.60** | 未觸頂 | **10 / 9.52**（鎖死） | **9 / 6.68** | 徹底解除飽和 |
| `tts_wait_seconds` 均值 / P95 | 151.5 / 242.5 ms | **161.3 / 248.8 ms** | 開始小幅爬升 | 152.3 / 242.5 ms | **178.4 / 334.2 ms** | **P95 +37.8%（出現 TTS 排隊）** |
| `ffmpeg_queue_length` 峰值 | 1 | 1 | — | 1 | **2**（`t=4.5s`） | **出現 ffmpeg 鎖排隊** |
| Peak CPU / RSS | 9.9% / 71.4 MB | 19.9% / 71.1 MB | 仍遠低於飽和 | 37.8% / 74.5 MB | 25.9% / 77.2 MB | 仍遠低於飽和 |

**S3b 混合負載（`W=3, Q=30`）`queue_depth` 趨勢**：
- `t=0.5s~2.5s` 穩定在 `q=0~3`；`t=3.0s~15.1s` 全程在 **`q=6~9`** 之間平穩震盪（遠低於上限 30，**0 次拒絕**）。
- 但在 `t=4.5s` 出現 **`ffmpeg_queue_length = 2`**，且 **`tts_wait_p95` 由 242.5 ms 跳升至 334.2 ms**——清楚暴露了擴容 Worker 後接棒的兩個次級瓶頸！

---

### 2.3 實機 Express HTTP 端點壓測（`S4_express_http_probes`）與真實上游延遲校準

#### A. Express 實機探針壓測（`http://127.0.0.1:3000`，20 users，10s）

| 端點 | 請求數 | 失敗數 | QPS | Avg 延遲 | P50 延遲 | P95 延遲 | P99 延遲 | Max 延遲 |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `GET /health` | 45 | 0 | 5.26 | 52.9 ms | 17.0 ms | 200.0 ms | 220.0 ms | 218.3 ms |
| `GET /metrics` | 46 | 0 | 5.38 | 46.9 ms | 11.0 ms | 220.0 ms | 310.0 ms | 313.2 ms |
| **`GET /ready`** | **2** | 0 | **0.23** | **7,527.0 ms** | **7,800.0 ms** | **7,800.0 ms** | **7,800.0 ms** | **7,806.8 ms** |

> **空載單次對比**：`/health` 11.8 ms、`/metrics` 1.9 ms、`/ready` **898.6 ms**（單獨執行 `python3 bot_bridge.py status` 3 次均值 **126.3 ms**）。在 20 併發下，`GET /ready` 每次請求都無快取地 `spawn(python3 bot_bridge.py status)`（`server.ts:819`），導致 Python 子行程啟動風暴，耗時暴增至 **7.8 秒**，連帶將原本 <2 ms 的 `/health` 與 `/metrics` P95 拖慢至 200–220 ms！

#### B. 實機真實上游 API 延遲（單次 `POST /api/bot/chat`）

| 真實請求類型 | HTTP 狀態 | 端到端耗時 | 備註 |
| :--- | :---: | ---: | :--- |
| 純文字（Gemini API 冷啟動首輪） | 200 | **13,960.7 ms** | 外部 LLM 推理與冷連線延遲主導 |
| 語音回覆（Gemini + Edge-TTS 兩句） | 200 | **4,021.3 ms** | 成功輸出 72,501 bytes MP3 音檔 |

#### C. `ffmpeg` 拼接微基準測試（現況 `libmp3lame -q:a 4` 重編碼 vs `-c copy` 串流複製）

程式碼 `bot/worker.py:216-236` 目前使用 `-c:a libmp3lame -q:a 4` 對所有 TTS 片段進行完整解碼＋重編碼。實測三種常見回覆音長（均為 3 段拼接，空載容器各跑 4 次取平均）：

| 音訊規格（3 段合併） | 現況 `libmp3lame -q:a 4` 均耗時 | 改用 `-c copy` 均耗時 | 加速倍數 |
| :--- | ---: | ---: | ---: |
| 3 × 0.6 秒（總長 1.8 秒） | 107.2 ms | 89.0 ms | **1.20×** |
| 3 × 3.0 秒（總長 9.0 秒） | 133.7 ms | 85.7 ms | **1.56×** |
| 3 × 10.0 秒（總長 30.0 秒） | **229.8 ms** | **99.3 ms** | **2.31×** |

`-c copy` 幾乎不受音檔長度影響（穩定於 ~90 ms 行程啟動成本），而現況 `libmp3lame` 重編碼耗時隨音長線性上升且額外消耗單核 CPU。

---

## 3. 瓶頸定位總結（逐項診斷）

| 候選瓶頸項目 | 判定結果 | 實測證據與根因分析 |
| :--- | :---: | :--- |
| **1. `BOT_WORKERS=1` 與單一 FIFO 佇列（`BOT_QUEUE_MAXSIZE=10`）** | **🔴 第一核心瓶頸（P0）** | 預設為 1 vCPU 保護而設 `BOT_WORKERS=1`（`bot/config.py:84`）。純語音 QPS 被鎖死在 **1.98 req/s**；混合負載在 12 併發下 **1 秒即打滿佇列、81.9% 請求 429 拒絕**，且快速文字請求遭慢速語音「隊頭阻塞（HoL Blocking）」。將 Worker 調至 3 後，純語音 QPS 暴增 **2.97×**、混合有效 QPS 暴增 **4.0×**、失敗率歸零。 |
| **2. Express `/ready` 與 Web Bridge 每次 `spawn(python3)`** | **🔴 Web 層核心瓶頸（P0）** | `server.ts:819` 在每次 `GET /ready` 都直接啟動新 `python3` 子行程（空載 126–899 ms，20 併發下飆升至 **7,806.8 ms**），同時拖慢同機 `/health` 與 `/metrics` 的 P95 延遲。若被 K8s/Cloud Run 多節點頻繁探活，極易引發假性不健康重啟。 |
| **3. 外部 LLM / TTS API 延遲與 `TTS_CONCURRENCY=3` 全域鎖** | **🟠 擴容後次級瓶頸（P1）** | 真實 Gemini + Edge-TTS 單次即需 **4.0s–13.9s**，屬典型 I/O-bound 工作負載。當 `BOT_WORKERS` 提升至 3（最多 3×3=9 句並行）時，所有 Worker 共用同一把 `asyncio.Semaphore(3)`（`bot/worker.py:312`），實測 `tts_wait_p95` 立即從 **242.5 ms 跳升至 334.2 ms（+37.8%）**；若接入免費層 Edge-TTS / Groq Whisper，更高併發還會直接觸發上游 429 限流。 |
| **4. `ffmpeg` 全域單鎖（`_ffmpeg_semaphore=1`）＋ 全量重編碼** | **🟠 擴容後次級瓶頸（P1）** | `bot/worker.py:313` 限制全行程僅 1 個 `ffmpeg` 同時運行，且 `:227-230` 強制 `libmp3lame -q:a 4` 重編碼。在 `W=3` 混合壓測中已觀測到 `ffmpeg_queue_max = 2`；對於 30 秒語音回覆，重編碼比 `-c copy` 慢 **2.31×**，拉長鎖持有時間。 |
| **5. CPU 算力** | **🟢 非瓶頸** | 全程所有場景（含真實 `ffmpeg` 重編碼與 12 併發混合負載）Peak CPU 僅 **9.9%–37.8%**（2 vCPU 環境），算力餘裕極大。 |
| **6. 記憶體（RAM）** | **🟢 非瓶頸** | Peak RSS 穩定在 **68.4–77.2 MB**，無記憶體洩漏跡象。 |
| **7. Redis 配額檢查** | **🟢 非瓶頸（有輕微冷突發抖動）** | 實作具備 30 秒 Fail-Open 熔斷（`bot/redis_client.py:28`），降級後零延遲；唯一小缺點是冷啟動或熔斷期滿瞬間，多個併發協程會同時撞擊失敗（實測 `redis_failures_total = 1~5`），建議以單次 flight lock 收斂為 1 次探測。 |

---

## 4. 優先級排序的優化建議

### P0（立即見效，吞吐量提升 3×–4×，消除 429 與探活超時）

1. **調高 Worker 併發與佇列深度（I/O-bound 工作負載匹配）**：
   - 在 2 vCPU / 4 GB 環境下，由於 LLM/STT/TTS 95% 以上時間在等待網路 I/O（CPU 使用率 <26%），建議將預設環境變數調整為：
     ```env
     BOT_WORKERS=4
     CONCURRENT_UPDATES=4
     BOT_QUEUE_MAXSIZE=32
     ```
   - **預期收益**：混合負載有效 QPS 提升 **3×–4×**，消除輕量突發流量下的 429 拒絕風暴。
2. **為 Express `GET /ready` 加入 10–15 秒 TTL 結果快取與 Single-Flight 去重**：
   - 修改 `server.ts` `/ready` 端點：快取 `runPythonBridge('status')` 結果（例如 TTL = 10 秒）並以共享 Promise 防止同時觸發多個 `python3` 子行程。
   - **預期收益**：`GET /ready` 在 20 併發下的 P95 延遲由 **7,800 ms 降至 <15 ms**（降幅 **99.8%**），並消除對 `/health`、`/metrics` 的尾延遲干擾。

### P1（架構級消除阻塞，解決擴容後次級瓶頸）

3. **文字與語音任務佇列分離（雙佇列 / 優先級排程）**：
   - 將 `WorkerPool` 拆分為「快速文字池（Text Queue）」與「重型語音池（Voice Queue）」，或使用 `asyncio.PriorityQueue` 讓文字請求優先調度。
   - **預期收益**：徹底根除混合負載下文字請求被語音任務拖累的 Head-of-Line Blocking（文字 P95 延遲可穩定維持在單純 LLM 耗時等級）。
4. **`ffmpeg` 拼接改用無損串流複製（`-c copy`）並依 CPU 核數開放併發**：
   - 在 `bot/worker.py:_concat_mp3` 中，同一 TTS Provider 產出的 MP3 編碼參數一致，優先使用 `-c copy`（失敗再降級 `libmp3lame`），甚至針對無 ID3 header 衝突的純 MP3 幀可免 fork 直接在記憶體合併。
   - 將 `_ffmpeg_semaphore` 改為可配置 `FFMPEG_CONCURRENCY = max(1, os.cpu_count() // 2)`（2 vCPU 設為 2）。
   - **預期收益**：30 秒語音拼接耗時減少 **57%（2.31× 加速）**，消除 `ffmpeg_queue_length >= 2` 的鎖排隊。
5. **讓 `TTS_CONCURRENCY` 可配置並區分 Provider 限流策略**：
   - 將 `bot/worker.py:37` 的硬編碼 `TTS_CONCURRENCY = 3` 改為環境變數（預設 `max(3, BOT_WORKERS * 2)`），並針對 Edge-TTS / OpenAI TTS 加入 Token Bucket 速率控制與短語音 LRU 快取（常見提示語、問候語免重複呼叫 TTS）。
   - **預期收益**：壓低多 Worker 下的 `tts_wait_p95`，同時避免上游 429 限流。

### P2（長期穩定性與進階效能）

6. **Express Web Bridge 常駐化（Unix Socket / Local HTTP Daemon）**：
   - 目前 Web 版每次文字/語音請求亦可能呼叫 `bot_bridge.py`，若改由常駐 Python FastAPI/asyncio 內部服務透過 Keep-Alive HTTP 通訊，可消除每次 ~126 ms 的 Python 冷啟動與 import 成本。
7. **Redis 熔斷探測加鎖（Single-Flight Cooldown Probe）**：
   - 在 `bot/redis_client.py` 熔斷期滿重試時，僅放行 1 個協程探測 Redis 存活狀態，其餘併發請求在探測完成前直接 fail-open，避免每次 30 秒期滿出現 1–5 筆併發超時抖動（`socket_connect_timeout=1.0s`）。
8. **監控告警閾值建議（搭配既有 Prometheus 指標）**：
   - `queue_depth / BOT_QUEUE_MAXSIZE > 0.8` 持續 15 秒 → 觸發擴容或降級告警（對應 `/ready` 逼近 503）。
   - `histogram_quantile(0.95, rate(tts_wait_seconds_bucket[5m])) > 2.0` → 檢查 TTS 併發數或上游限流。
   - `ffmpeg_queue_length >= 2` 持續 10 秒 → 檢查音檔過長或調高 `FFMPEG_CONCURRENCY`。
   - `increase(redis_failures_total[5m]) > 0` → 檢查 Redis 連線狀態。

---

## 5. 瓶頸修復落地與前後實測驗證（Before vs After）

已完成 6 項核心修復並通過全部 156 項單元測試（`pytest`）、`mypy`、`ruff` 與 TypeScript 嚴格檢查，接著以完全相同的 Locust 併發設定重跑實測驗證：

### 已落地修改清單
1. **`bot/config.py` & `.env.example`**：調高 I/O-bound 預設併發（`BOT_WORKERS=4`、`CONCURRENT_UPDATES=4`、`BOT_QUEUE_MAXSIZE=32`），新增可配置 `TTS_CONCURRENCY`（預設 `8`）與 `FFMPEG_CONCURRENCY`（預設依 CPU 核數設為 `2`）。
2. **`bot/worker.py`（PriorityQueue）**：將單一 FIFO 佇列升級為 `asyncio.PriorityQueue`，快文字任務（`priority=0`）優先於語音任務（`priority=1`）調度，同優先級維持嚴格 FIFO，徹底消除混合負載隊頭阻塞（HoL Blocking）。
3. **`bot/worker.py`（`_concat_mp3`）**：改為優先使用無損串流複製 `-c copy`，僅於失敗或空輸出時自動降級 `libmp3lame -q:a 4`，並搭配 `FFMPEG_CONCURRENCY` 信號量。
4. **`bot/redis_client.py`**：為冷啟動與 30 秒熔斷期滿恢復探測加上 Single-Flight 鎖（`_probing`），避免多協程併發撞擊失敗。
5. **`server.ts`（`GET /ready`）**：加入 **10 秒 TTL 快取（失敗 2 秒）＋ Single-Flight Promise 去重**，消除併發探活造成的 `python3` 子行程啟動風暴。

### 修復前後實測數據對照（100% 實測）

| 測試場景與關鍵指標 | 修復前（基準 `W=1, Q=10`） | 修復後（新版預設 `W=4, Q=32`） | 實測改善幅度 |
| :--- | ---: | ---: | :--- |
| **S1 純文字 QPS**（10u） | 7.95 req/s | **29.47 req/s** | **+270.7%（3.71×）** |
| **S1 純文字 P50 / P95** | 1,100 / 1,200 ms | **210 / 290 ms** | **P50 -80.9% / P95 -75.8%** |
| **S2 純語音 QPS**（10u） | 1.98 req/s | **6.82 req/s** | **+244.4%（3.44×）** |
| **S2 純語音 P50 / P95** | 4,600 / 4,900 ms | **1,200 / 1,500 ms** | **P50 -73.9% / P95 -69.4%** |
| **S3 混合有效 QPS**（12u） | 2.43 req/s | **12.77 req/s** | **+425.5%（5.26×）** |
| **S3 混合 429 失敗率** | 81.9%（154/188） | **0.0%（0/137）** | **徹底歸零** |
| **S3 混合文字 P95**（HoL 消除） | 3,500 ms（W=3 FIFO: 1,300 ms） | **550 ms**（P50 220 ms） | **-84.3%（較 FIFO 再降 57.7%）** |
| **S3 混合 `tts_wait_p95`** | 334.2 ms（W=3, TTS=3） | **245.0 ms**（TTS=8） | **-26.7%（消除 TTS 排隊）** |
| **S3 混合 `queue_depth` 峰/均** | 10 / 9.52（鎖死） | **8 / 4.42**（上限 32） | **徹底解除飽和** |
| **Redis 冷啟動併發失敗數** | 2–5 次併發撞擊 | **固定 1 次** | **Single-Flight 精準收斂** |
| **S4 Express 總 QPS**（20u） | 10.87 req/s（93 reqs） | **176.05 req/s**（1,586 reqs） | **+1,520%（16.2×）** |
| **S4 `GET /ready` P50 / P95** | 7,800 / 7,800 ms（0.23 rps） | **4.0 / 18.0 ms**（25.75 rps） | **P95 -99.77%（QPS 112×）** |
| **S4 `GET /health` P95** | 200.0 ms | **11.0 ms** | **-94.5%** |
| **S4 `GET /metrics` P95** | 220.0 ms | **12.0 ms** | **-94.5%** |

