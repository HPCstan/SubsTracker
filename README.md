# SubsTracker — 订阅管理与提醒系统

基于 **Cloudflare Workers + KV** 的轻量级订阅到期提醒。在网页里管理订阅，到点通过 Telegram / Bark / 企业微信 / ntfy 等 **11 种渠道** 推送，并自带发送与调度日志方便排查。

**适合**：个人自托管、域名/会员/账单到期提醒。  
**不适合**：多用户协作、复杂企业审批流。

---

## 🧩 本機改動紀錄

> 本 fork 相對上游做過五組改動（2026-11）：**排程改用 Durable Object alarm**、**介面簡體轉繁體（台灣用語）**、**預設時區改為 `Asia/Taipei`**、**資料概覽可切換統計幣別並拆分月度／預估年／實際年度支出**、**修正儀表板「任務歷史」欄位讀錯與時區標籤**。
> 線上部署：`https://subscription-manager.ogeypt.workers.dev`（Cloudflare Workers Free 方案，Worker 名稱 `subscription-manager`，目前版本 `abb94187`）。

### 1. 排程改用 Durable Object alarm（取代 Cron Trigger）

**問題**：Workers Free 方案每個帳號最多 5 個 Cron Trigger。本帳號已用滿（`error code: 10072`），`0 * * * *` 掛不上去，`npm run deploy` 直接失敗。

**解法**：完全不使用 Cron，改用 Durable Object 的 alarm 自我排程，不佔用 Cron 名額。

| 檔案 | 改動 |
|---|---|
| `src/services/scheduler-alarm.js`（新增） | `SchedulerAlarm` DO。`fetch()` 為冪等預約：只有 `storage.getAlarm() === null` 時才設定下一個整點（`nextHourStart()`），重複呼叫不會推遲已排定的時間。`alarm()` 執行 `ensureMigrations(env)` + `checkExpiringSubscriptions(env)`，成功寫入 `lastRun`、清掉 `lastError`；失敗把 stack 存進 `lastError`；`finally` 一律續排下一個整點。 |
| `src/index.js` | `export { SchedulerAlarm }`；新增 `armScheduler(env)`，在請求進來時以 `ctx.waitUntil()` 呼叫 `env.SCHEDULER.get(env.SCHEDULER.idFromName('hourly')).fetch('/arm')` 補掛 alarm（alarm 鏈中斷後可自我修復）。原有 `scheduled` handler 保留，日後升級付費方案可直接掛回 Cron。 |
| `wrangler.toml` | 移除 `[triggers] crons`；新增 `[[durable_objects.bindings]]`（`name = "SCHEDULER"` → `class_name = "SchedulerAlarm"`）與 `[[migrations]] tag = "v1" new_sqlite_classes = ["SchedulerAlarm"]`（免費方案的 DO 必須使用 SQLite 後端）。 |

**行為差異**：觸發點仍是每個整點（UTC），時區判斷、允許傳送小時、去重等邏輯**完全沿用** `src/services/scheduler.js`，與原本 Cron 一致，只是「誰來觸發」換了。

**驗證**：部署後 `wrangler tail` 出現 `[scheduler-alarm] armed for 2026-11-15T14:00:00.000Z`；KV 每小時產生一筆 `sched_log:<ISO 時間>`；實測 `2026-11-16T00:00:00.243Z` 觸發，內容 `status: ok`、`timezone: Asia/Taipei`、`currentHour: 08`、`inWindow: true`。

### 2. 介面簡體 → 繁體（台灣用語）

- 以 `opencc-js`（`from: 'cn'`, `to: 'twp'`）轉換 `src/**`、`public/**`、`tests/**` 與 `vitest.config.js`，共 78 個 `.js` / `.html`；反覆轉換至冪等收斂（第二輪變動數為 0），並保留原檔 UTF-8 編碼與 BOM 狀態。
- 轉換是**純字串處理**，不改程式結構。已確認沒有任何中文字串被用在邏輯比較（`===` / `!==` / `includes()` / `startsWith()` / `switch` / `case` 皆無中文字面量），因此行為不受影響。
- OpenCC 未處理的用語另行手動修正：`賬號 → 帳號`、`賬戶 → 帳戶`、`悉尼 → 雪梨`。
- 台灣用語對照結果：`服務器 → 伺服器`、`默認 → 預設`、`用戶 → 使用者`、`網絡 → 網路`、`文件 → 檔案`、`數據庫 → 資料庫`、`儀表板 → 儀錶板`。
- `tests/**` 一併轉換，確保測試斷言的字串與畫面輸出一致。

### 3. 預設時區改為 `Asia/Taipei`

| 檔案 | 改動 |
|---|---|
| `src/data/config.js` | `DEFAULT_CONFIG.TIMEZONE: 'Asia/Taipei'`（新安裝／未設定時的預設值） |
| `src/data/subscriptions.js` | 4 處 fallback 改為 `config.TIMEZONE \|\| 'Asia/Taipei'` |
| `src/core/time.js` | `extractTimezone()` 新增：`zh-TW` / `zh-HK` / `zh-Hant` → `Asia/Taipei`；`zh-CN` 與 `zh` 仍對應 `Asia/Shanghai` |
| `src/views/configPage.html` | 靜態選單與動態 `generateTimezoneOptions()` 的推薦分組改為 `🇹🇼 推薦`，`臺北時間` 排第一；`Asia/Shanghai` 移到下方仍可選；`fallbackTimezone`、未知時區提示文字同步改為 `Asia/Taipei` |
| `src/views/adminPage.html` | `globalTimezone` 的 fallback 改為 `Asia/Taipei` |
| `src/api/debug.js` | `/debug` 診斷頁的說明範例改為 `TIMEZONE=Asia/Taipei`（台北時間 8 點填 `08`） |
| KV `config`（線上） | 以 `wrangler kv:key put` 將既有設定中的 `TIMEZONE` 由 `Asia/Shanghai` 改為 `Asia/Taipei`；其餘 41 個欄位（帳號、通知渠道、金鑰等）原樣保留 |

**為何不只改程式預設值**：線上 KV 已存在完整 `config` 物件，`loadConfig()` 會直接讀取該物件，程式預設值不會生效，因此必須同時更新 KV。

### 4. 驗證紀錄

- `npm run lint`（`tsc --noEmit -p jsconfig.json`）：通過，無錯誤。
- `npm test`：**24 個測試檔 / 266 個測試全數通過**。
  - ⚠️ 若專案路徑含空白（例如 `D:\ag\...\github install\SubsTracker`），`@cloudflare/vitest-pool-workers` 會解析出錯誤的模組路徑（`No such module ".../file:/..."`），導致 0 個測試被收集、23 個 error。此為環境問題，與程式碼無關；把專案複製到**無空白路徑**再執行 `npm test` 即可正常跑完。
- 線上實測（登入後逐頁抓取 HTML）：`/login`、`/admin`、`/admin/dashboard`、`/admin/notify-logs`、`/admin/config`、`/debug` 皆為繁體，且無簡體字殘留。
- Durable Object alarm 實跑：`sched_log` 每小時一筆，`timezone` 已為 `Asia/Taipei`。

### 5. 資料概覽可切換統計幣別（CNY / TWD / USD）

**需求**：首頁「資料概覽」原本一律以人民幣（CNY）總結，需可切換新台幣（TWD）與美金（USD）。

**先修掉一個潛伏的匯率錯誤**：`FALLBACK_RATES` 舊值是「1 外幣 = X CNY」（USD 6.98、TWD 0.22），但程式用 `amount / rate`，而匯率 API（`base=CNY`）回傳的是「1 CNY = X 外幣」，方向相反。且 `frankfurter` 的 `base=CNY` **不含 TWD**，TWD 一直落到兜底值 0.22 → NT$50 被算成 227 CNY（約 20 倍膨脹），畫面才會出現 `¥19083.09` 這種數字。

| 檔案 | 改動 |
|---|---|
| `src/core/currency.js` | ① `FALLBACK_RATES` 改為「1 CNY = X 外幣」（USD 0.14、TWD 4.50、HKD 1.09、JPY 20.5、EUR 0.13、GBP 0.11、KRW 190、TRY 4.60）。② 新增 `DISPLAY_CURRENCIES = ['CNY','TWD','USD']`。③ 新增 `RATE_SOURCES`：`open.er-api.com/v6/latest/CNY`（166 幣，含 TWD）優先、`api.frankfurter.dev/v1/latest?base=CNY`（29 幣，無 TWD）備援；`getDynamicRates()` 逐來源嘗試並**優先採用含 TWD 的來源**，快取 key 升為 `SYSTEM_EXCHANGE_RATES_V2`（舊快取方向錯誤，不再沿用），TTL 由 24 小時縮短為 **6 小時**（貼近即時匯率）。④ 新增 `convertCurrency(amount, from, to, rates)` = `(amount / rates[from]) * rates[to]`。⑤ **月度支出改為「攤平到月」**：新增 `getMonthlyShare()`（月繳 ×1、年繳 ÷12、日租 ×30.4375），`calculateMonthlyExpense()` 不再依賴本月付款紀錄，而是把每筆啟用中訂閱的 `amount` 攤平後加總；趨勢改為與「上月攤平值」比較（只計本月之前已存在的訂閱）。⑥ 其餘 `calculateYearlyExpense` / `getExpenseByType` / `getExpenseByCategory` 仍以**今年實際付款**為基礎，只增加 `targetCurrency = 'CNY'` 參數做換算。 |
| `src/api/handlers/dashboard.js` | `handleDashboardStats(env, config, url)` 讀 `?currency=`，用 `DISPLAY_CURRENCIES` 驗證（非法值回退 `CNY`），傳入四個聚合函式，回應新增 `data.currency` 與 `data.projectedYearlyExpense`（= `monthlyExpense.amount × 12`）。 |
| `src/api/router.js` | `/dashboard/stats` 將 `url` 傳入 handler。 |
| `src/views/dashboardPage.html` | 「資料概覽」列新增 `#displayCurrency` 下拉（人民幣／新台幣／美金），選擇存 `localStorage['dashboardDisplayCurrency']`；`loadDashboardData()` 改打 `/api/dashboard/stats?currency=...`；副標、四張統計卡的幣別文字與 `¥` 符號、兩個排行徽章（`#expenseTypeBadge` / `#expenseCategoryBadge`）、排行金額全部改為動態（沿用既有 `getSymbol()`）。統計卡由 3 張改為 4 張（`md:grid-cols-2 xl:grid-cols-4`）：**月度支出**（副標「每月攤平（年繳 ÷12）」）、**預估年支出**（副標「每月攤平 × 12」）、**實際年度支出**（副標「今年已付 · 平均每月 X」）、活躍訂閱；排行徽章改為「實際年度 (摺合XXX)」。 |
| `tests/core/currency-display.test.js`（新增） | 16 個測試：`convertCurrency` 同幣別／TWD→CNY／CNY→USD／往返不失真／0 與負數、`FALLBACK_RATES` 方向（並斷言 NT$50 不會被放大）、四個聚合函式的 `targetCurrency` 行為，以及攤平規則（年繳 650 → 650/12、停用訂閱不計、月繳＋年繳＋美金混合加總、本月新增訂閱使趨勢往上）。既有 `convertToCNY` 語義未動（`auth-currency.test.js` 仍通過）。 |

**三種支出口徑（同時顯示，互不覆蓋）**：

| 統計卡 | 計算方式 | 用途 |
|---|---|---|
| 月度支出 | `Σ(每個啟用中訂閱的 amount 攤平到月)`，年繳 ÷12、日租 ×30.4375 | 現在每月固定負擔（月初還沒扣款也不會低估） |
| 預估年支出 | 月度支出 × 12 | 維持目前訂閱組合一年的總花費 |
| 實際年度支出 | 今年已實際付款總和（年繳以全額計） | 今年真的付出去的錢（與右側「按型別／按分類」排行同口徑） |

`實際年度支出` 與 `預估年支出` 會有落差，是因為今年才建檔、多數訂閱在 11 月才開始，以及年繳在年初一次付清；三者都在卡片副標寫明算法。

**驗證**（線上實測，`/api/dashboard/stats`，2026-11-17）：

| 請求 | 回傳 `currency` | 月度支出（攤平） | 預估年支出（×12） | 實際年度支出（今年已付） |
|---|---|---|---|---|
| `?currency=CNY`（或省略） | `CNY` | 1,104.97 | 13,259.63 | 1,319.48 |
| `?currency=TWD` | `TWD` | 5,448.57 | 65,382.79 | 6,506.31 |
| `?currency=USD` | `USD` | 165.43 | 1,985.21 | 197.55 |
| `?currency=XXX` | `CNY`（回退） | 1,104.97 | 13,259.63 | 1,319.48 |

三者互為同一筆金額：1,104.97 CNY × 4.930966 ≈ 5,448.57 TWD ≈ 165.43 USD（×32.935），與即時匯率一致（匯率每 6 小時更新，數字會有小數點後的微幅變動）。`/admin/dashboard` HTML 已含下拉、四張統計卡與動態符號模板，無硬編 `¥` 金額。部署版本 `f88b4f08-f77a-4886-bc21-b35da73c8b98`。

### 6. 修正儀表板「自動提醒任務歷史」顯示（未知時間／永遠未傳送）

**症狀**：儀表板下方「自動提醒任務歷史（最近10次）」每一筆都顯示「**未知時間 · 未傳送**」，即使該次真的發送成功也一樣；上方「自動提醒任務狀態」卡卻正常。

**原因**：`data.schedulerStatusHistory` 是 `scheduler-logs.repo.getRecent()` 的**原始紀錄**，欄位為 `startedAt` / `finishedAt` / `checkedCount` / `matchedCount` / `sentCount` / `reason`；`handler` 只把這些欄位**映射成** `lastRunAt` / `sent` 放進 `schedulerStatus`（摘要物件）。前端歷史列表卻直接讀摘要物件的欄位名，因此：

- `item.lastRunAt` → `undefined` → 時間永遠「未知時間」
- `item.sent` → `undefined` → 狀態永遠「未傳送」（連成功發送也會顯示未傳送）

**改動**（`src/views/dashboardPage.html`，共 3 處）：

| 位置 | 改動 |
|---|---|
| 任務歷史（約 396 行） | 時間改讀 `item.startedAt \|\| item.finishedAt`；狀態改讀 `(item.sentCount \|\| 0) > 0`；第二行改為「檢查 X · 命中 Y · 送出 Z」+ 原因，資訊與排程日誌一致 |
| 狀態卡時區標籤（約 372 行） | `當前小時 / 配置時段（UTC）` 改為 `（${status.timezone \|\| 'UTC'}）` —— `currentHour` 原本就是按使用者時區計算，標 UTC 會誤導（台北 01:00 會被讀成 UTC 01:00） |
| 時間格式 locale（狀態卡與歷史） | `toLocaleString('zh-CN')` → `toLocaleString('zh-TW')`，與全站繁體一致 |

**為什麼「本次未傳送」在這些紀錄裡是正確的**：提醒規則是**精確日**設計（「到期前 N 天」只在剩餘天數**正好等於 N** 那天發）。2026-11-19 那次檢查 8 條、命中 0 條，因為沒有任何訂閱當天剛好落在自己的提醒日；下一次實際發送是 **2026-11-24 01:00（台北）**，opencode 到期前 1 天。

**驗證**（部署 `abb94187`，線上 HTML 與 API 實測）：

| 檢查項 | 結果 |
|---|---|
| 使用 `item.startedAt \|\| item.finishedAt` | ✅ |
| 使用 `(item.sentCount \|\| 0) > 0` | ✅ |
| 顯示「檢查 · 命中 · 送出」 | ✅ |
| 時區標籤改為動態（`Asia/Taipei`） | ✅ |
| 舊的 `item.lastRunAt` 殘留 | 無 |
| 第一筆紀錄實際欄位 | `startedAt=2026-11-18T17:00:00.236Z`、`sentCount=0`、`matchedCount=0`、`checkedCount=8` |

### 7. 注意事項

- 改動**之前**產生的 `sched_log` 與通知紀錄仍寫著 `Asia/Shanghai`，屬歷史資料，不影響後續執行。
- 本 fork 與上游 `wangwangit/SubsTracker` 已大幅分歧（`src/views/**`、`tests/**` 幾乎全改），直接 `git pull` 會產生大量衝突。
- 本 README 主體仍為簡體中文，**只有本節為繁體**；若要整份轉換請另行處理。
- 免費方案下 alarm 依賴 Durable Object 自我續排；若 alarm 鏈中斷（例如 DO 被驅逐且未續排），下一個請求進來時 `armScheduler()` 會自動補掛，不會永久停擺。

---

## 目录

1. [🧩 本機改動紀錄](#-本機改動紀錄)
2. [5 分钟上手](#-5-分钟上手)
3. [部署](#-部署)
4. [第一次必做配置](#-第一次必做配置)
5. [日常怎么用](#-日常怎么用)
6. [通知到底怎么工作](#-通知到底怎么工作重点必读)
7. [功能一览](#-功能一览)
8. [常见问题 FAQ](#-常见问题-faq)
9. [升级 / 开发 / 第三方 API](#-升级--开发--第三方-api)
10. [安全提醒](#-安全提醒)

---

## 🚀 5 分钟上手

```text
部署 Worker
  → 用 admin / password 登录（立刻改密码）
  → 系统配置：选时区（中国选 Asia/Shanghai）
  → 系统配置：允许发送的小时（例如只想早上 8 点发就填 08）
  → 勾选至少一种通知渠道并填好 Token，点「测试」直到成功
  → 订阅列表：添加订阅（可用默认提醒预设 7/3/1 天 + 当天）
  → 到点后去「通知历史」看是否发送 / 为何跳过
```

若中途卡住，先看下方 [常见问题 FAQ](#-常见问题-faq)。

---

## 📦 部署

### 方式一：命令行（推荐）

```bash
git clone https://github.com/wangwangit/SubsTracker.git
cd SubsTracker
npm install

# Linux / macOS
export CLOUDFLARE_API_TOKEN=你的token
# Windows PowerShell
# $env:CLOUDFLARE_API_TOKEN="你的token"

npm run deploy:safe
```

`deploy:safe` 会：

1. `npm run setup` — 自动创建 / 绑定 KV（`SUBSCRIPTIONS_KV`）
2. `npm run deploy` — 部署 Worker

部署成功后，终端会打印类似：

`https://subscription-manager.<你的子域>.workers.dev`

### 方式二：GitHub Actions

1. Fork 本仓库  
2. 仓库 **Settings → Secrets and variables → Actions** 增加：

| Secret | 说明 |
|--------|------|
| `CLOUDFLARE_API_TOKEN` | 需 Workers 编辑 + KV 编辑权限 |
| `CLOUDFLARE_ACCOUNT_ID` | 可选 |

3. 推送到 `master` / `main` 或手动运行 **Deploy** workflow  

### 默认登录

| 项 | 值 |
|----|-----|
| 用户名 | `admin` |
| 密码 | `password` |

**登录后请立刻在「系统配置」修改密码。** 公网暴露默认密码会被接管。

### 忘记密码

Cloudflare Dashboard → **Workers & Pages → KV** → 打开 `SUBSCRIPTIONS_KV` → 编辑 key `config` 的 JSON，修改 `ADMIN_PASSWORD` 后保存。

---

## ✅ 第一次必做配置

打开 **系统配置**，建议按顺序做完：

### 1. 改密码

管理员用户名 / 密码改成自己的。页面若提示仍是默认 `admin`，请务必处理。

### 2. 时区

- 中国大陆用户：**`Asia/Shanghai`（北京时间）**
- 所有「到期还有几天」「几点发通知」都以这里为准

### 3. 允许发送的小时

| 你填什么 | 含义 |
|----------|------|
| `08` | **仅**北京时间 **8 点那一小时**会发（约 8:00–8:59 的那次整点检查） |
| `08, 20` | 早上 8 点、晚上 8 点各可能发一次 |
| **留空** 或 `*` | **每个整点**都可以发 |

要点：

- 系统大约 **每小时整点** 检查一次（Cron：`0 * * * *`，按 UTC 触发，但判断用你配置的时区）。
- 填了 `08`、现在是 19 点：**不会发**。通知历史里出现「不在允许发送的小时」是 **正常跳过**，不是坏了。
- 配置页下方有实时预览（会显示「当前会发 / 不会发」）。**改完要点保存**，预览才与服务器一致。

### 4. 打开至少一种通知渠道

勾选渠道 → 填 Token / Chat ID 等 → 点 **测试 xxx 通知**，确认手机/群里能收到。

常用渠道简表：

| 渠道 | 你需要准备 |
|------|------------|
| Telegram | Bot Token + Chat ID；Forum 群可选 Topic ID |
| Bark | Device Key；自建可填 Server |
| 企业微信 | 群机器人 Webhook |
| ntfy | Server（默认 ntfy.sh）+ Topic；可选 Token |
| WPUSH | API Key；可选 Channel / Topic 编码 |
| 邮件 | Resend API Key + 收发邮箱 |
| Webhook | 任意 HTTP 地址 + 可选模板 |

### 5. 加一条测试订阅

- 到期日设近一点，提醒规则可用 **「应用预设 7/3/1/当天」**
- 或临时加一条「到期前 0 天 / 到期当天」，并把「允许发送的小时」改成当前小时做联调（测完改回）

---

## 📋 日常怎么用

### 订阅列表

| 操作 | 说明 |
|------|------|
| 添加 / 编辑 | 名称、周期、金额、分类、农历等 |
| **克隆** | 复制一条（名称带「副本」），适合 esim 保号等同构订阅 |
| 续订 | 手动延长周期并记支付 |
| 停用 / 启用 | 停用后不再提醒（本地刷新，不必整页重载） |
| 测试 | 立刻对该订阅发一条测试通知 |
| 历史 | 支付记录 |
| 筛选 | 关键词、循环/重置模式、**状态**（正常/即将到期/已过期/已停用）、分类 |

### 提醒规则（每条订阅可多条）

默认预设：**到期前 7 天、3 天、1 天 + 到期当天**。

**重要语义（很多人误解这里）：**

> 「到期前 N 天」= **剩余天数正好等于 N 的那一天发一次**  
> **不会**从第 N 天起每天连发。

若要 7、6、5… 都提醒，需要多条规则，或使用预设 7/3/1/当天。

其它类型：

- **到期当天**
- **到期后**：每隔 X 小时提醒，直到你续费（受「允许发送的小时」约束）

### 订阅模式：循环 vs 到期重置

| 模式 | 一句话 | 例子 |
|------|--------|------|
| **循环订阅** | 未过期就从**当前到期日**往后接 | 会员 6/15 到期，6/3 续费 → 新到期约 7/15 |
| **到期重置** | 从**支付日**重新算一整段周期 | 保号卡充值日重新起算 180 天 |

### 周期快捷

表单里可用 **季度 / 半年 / 一年** 快捷（本质是 3 个月 / 6 个月 / 1 年）。  
公历可勾选 **「每月最后一天」**（适合「每月月末提醒」；农历下不用这个）。

### 备份与迁移

在 **系统配置** 最下方：

1. **导出备份** → 下载 JSON（默认可不含密钥）
2. 换账号 / 重装后 **导入**  
   - **合并**：按订阅 ID 覆盖同名，保留其它  
   - **覆盖**：先清空再整包导入（危险，先导出当前数据）

升级大版本或迁移 CF 账号前，**先导出一份**。

---

## 🔔 通知到底怎么工作（重点必读）

```text
每小时整点 Cron
  → 看现在是否在「允许发送的小时」（按时区）
  → 看每条启用中的订阅是否命中某条提醒规则（精确日/小时）
  → 去重（同一天同一规则不重复刷）
  → 发到你启用的渠道
  → 写入「通知历史」+「调度日志」
```

「允许发送的小时」是发送窗口。例如填 `08, 12`，命中同一条日级规则后通常只在 08 点发送一次，12 点不会重复发送；它不是每天发送两次的计划。

| 现象 | 通常原因 |
|------|----------|
| 任务历史：不在允许发送的小时 | 当前整点不在你填的 `08` 等列表里 → **正常** |
| 在窗口内但 sentCount=0 | 今天没有规则被命中（还没到「正好 N 天」） |
| 有 failed 记录 | 渠道配置错 / Token 失效 / 网络拒绝 → 看错误详情 |
| 一天只在 8 点附近收到 | 你只配置了 `08`，符合预期 |
| 希望一天提醒多次 | 把允许小时写成多个，如 `08, 12, 20`，或留空 |

**列表上的「提醒」列**：显示该订阅真实多规则摘要（如 `提前 7/3/1 天 · 到期当天`），与后台 `reminder_rules` 一致。

---

## ✨ 功能一览

### 订阅

- 增删改查、启用/停用、克隆、筛选  
- 多规则提醒、农历周期、自动/手动续订、支付历史  
- 季/半年快捷、公历月末选项  

### 通知渠道（10）

Telegram · NotifyX · Webhook · 企业微信 · Resend 邮件 · Bark · Gotify · Server酱 · PushPlus · ntfy · **WPUSH**

### 可观测

- `/admin/notify-logs`：发送成功/失败明细  
- 调度日志：命中/去重/跳过原因  
- `/debug`：时区与通知窗口诊断（需登录）  

### 财务

多币种、仪表盘支出统计（依赖支付记录与汇率；汇率接口失败时有兜底）

---

## ❓ 常见问题 FAQ

### 1. 为什么没收到通知？

按顺序查：

1. **系统配置**是否启用了渠道？「测试」能否收到？  
2. **允许发送的小时**是否包含「现在」？（填了 `08` 则只有 8 点）  
3. **时区**是否是 `Asia/Shanghai`？  
4. 该订阅是否 **启用**？提醒规则是否启用？  
5. 今天是否正好命中「到期前 N 天 / 当天」？  
6. 打开 **通知历史**：  
   - 有 failed → 看渠道报错  
   - 只有跳过、写着不在允许小时 → 等到配置的小时  
   - 完全没有相关记录 → 可能还没到整点检查，或规则未命中  

### 2. 任务历史写「不在允许发送的小时 / 不在配置时段」？

说明定时任务跑了，但当前小时不允许发。  
例如只允许 `08`，晚上 19 点跳过 → **正常**。  
到北京时间 8 点再看是否发送。

### 3. 设置了「到期前 7 天」，为什么第 6～1 天没有通知？

这是 **精确日** 设计：只在剩余 **正好 7 天** 那天发。  
需要多天提醒请加多条规则，或用预设 **7/3/1/当天**。

### 4. 列表提醒一直显示「提前 7 天」？

当前版本列表会读真实规则摘要。请 **强制刷新**（Ctrl+Shift+R）。  
若仍不对，打开浏览器开发者工具 → Network → `subscriptions`，看返回里是否有 `reminderRulesSummary`。

### 5. 克隆按钮看不见或没颜色？

操作列有 **克隆**（青色）。强制刷新；按钮在「编辑」后面。  
若只有灰字，确认已部署含主题样式的最新版本。

### 6. 循环订阅和到期重置有啥区别？

见上文表格：会员续费用 **循环**；按充值日重算周期用 **重置**。

### 7. 如何备份 / 换 Cloudflare 账号？

系统配置 → **导出备份** → 新环境部署后 **导入**。  
覆盖模式会清空现有订阅，操作前再导出一次当前数据。

### 8. Telegram 如何发到群话题（Topic）？

系统配置 → Telegram → 填写可选 **Topic ID**（对应 `message_thread_id`）。  
普通私聊/普通群可留空。

### 9. ntfy 怎么配？

启用 ntfy → Server 默认 `https://ntfy.sh` → 填自己的 Topic → 手机 ntfy App 订阅同一 Topic → 点测试。

### 10. WPUSH 怎么配？

启用 WPUSH → 在 [设置页](https://wpush.cn/settings) 获取 API Key → 可选填写渠道 / Topic 编码 → 点测试。成功条件为接口返回 `code === 0`。

### 11. 控制台里 `beacon.min.js` / cloudflareinsights 报错？

那是 **Cloudflare 统计脚本**，不是本项目业务代码。一般可忽略，与订阅列表无关。

### 12. Authentication error [code: 10000]（部署时）

Token 权限不足或 Wrangler 缓存问题：检查 API Token 权限，必要时删 `.wrangler/` 后重试。

### 13. 第三方系统想调通知接口？

在系统配置生成 **第三方 API 令牌** 后：

```bash
curl -X POST "https://你的域名.workers.dev/api/notify/你的令牌" \
  -H "Content-Type: application/json" \
  -d '{"title":"标题","content":"正文"}'
```

也可用请求头：`Authorization: Bearer 你的令牌`。

---

## 🔄 升级

```bash
git pull
npm install
npm run deploy:safe
```

首次访问会自动做 KV 结构迁移。升级前建议 **导出备份**。

> 若很久以前按 **UTC** 理解「通知小时」，现在请一律按配置里的 **时区**（如北京时间）理解，并到配置页看预览。

---

## 🛠 开发

```bash
npm install
npm test           # 单元 / 集成测试
npm run lint
npx wrangler dev --config wrangler.dev.toml --local
# http://127.0.0.1:8787  默认 admin / password
```

```text
src/
├── index.js           # fetch + scheduled 入口
├── app.js             # Hono
├── core/              # 时间、农历、货币、JWT
├── data/              # KV 与迁移
├── services/          # 调度器 + 通知渠道
├── api/               # 路由与 handler
└── views/             # 管理端 HTML
public/                # 静态资源（如 api-client.js）
tests/                 # Vitest + workerd
```

---

## 🔐 安全提醒

1. **立刻修改** 默认 `admin` / `password`  
2. 不要把 API Token、Bot Token 提交进 Git  
3. 备份 JSON 若勾选「包含敏感配置」，请当密码一样保管  
4. 对话、截图里不要长期暴露 Cloudflare API Token；泄露请到 Dashboard **轮换 Token**

---

## 🤝 贡献与协议

欢迎 Issue / PR。业务逻辑变更请尽量带测试。  
MIT License。

---

## 关注作者

![image](https://github.com/user-attachments/assets/96bae085-4299-4377-9958-9a3a11294efc)

CDN 加速由 Tencent EdgeOne 赞助。
