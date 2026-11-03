# 安全：標頭、session 與安全審查

> `e11-t23`（CSP 與安全標頭、session 列表與「登出其他裝置」）、`e11-t24`（對照 OWASP ASVS Level 1 的安全審查）。2026-10-30 第一次審查；同日 V3（`e1-t36`、`e11-t28`、`e11-t30`、`e11-t32`）修掉 §4 的四項；2026-11-02 加上管理員的兩步驟登入（`e11-t31`），同日社長決定改成**管理員一定要開**、加 QR code 與只有一位管理員時的救援。
> 改了驗證、session、可見性、上傳或標頭，回來對照這份文件，並更新 §3 的狀態。

## 1. 範圍與做法

- **範圍**：這個 Worker（`worker/`）、它的 Durable Object（`Club`、`TableObject`、`EventObject`）、牌桌的前端（`src/`），以及淡江橋館經 Vercel 轉發來呼叫的 `/api/book/*`。不含 Cloudflare 本身與淡江橋館的前端（那邊另做）。
- **標準**：[OWASP ASVS 4.0.3](https://github.com/OWASP/ASVS/tree/v4.0.3) Level 1。逐章讀程式碼與測試對照，不做滲透測試。
- **結果分三種**：✅ 已符合（附在哪裡）、🔧 這個 PR 修好、📋 待辦（§4 每項一個 task）。

## 2. 安全標頭與 CSP（`e11-t23`）

兩個地方送標頭，內容都定義在 `worker/security-headers.ts`：

| 回應 | 從哪裡送 | 標頭 |
| --- | --- | --- |
| 網頁與它的檔案（`index.html`、`/assets/*`、圖示） | 靜態資產不經過 Worker，由 `public/_headers` 給（`headersFile()` 產生，`tests/worker/account-security.test.ts` 檢查兩邊一致） | `PAGE_HEADERS`：CSP、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`、HSTS 兩年、`Cross-Origin-Opener-Policy: same-origin`、`Permissions-Policy`（關掉相機、麥克風、定位、付款、USB） |
| `/api/*`、`/ws` | `worker/index.ts` 的 `withSecurityHeaders` | `API_HEADERS`：`default-src 'none'; frame-ancestors 'none'; sandbox`、`X-Frame-Options: DENY`、nosniff、Referrer-Policy、HSTS。回應自己設的不覆蓋；WebSocket 升級（101）不動 |
| `/api/files/*`（簽名網址的圖片與電子書 PDF） | 同上 | 只有 nosniff、Referrer-Policy、HSTS：淡江橋館的 PDF 閱讀器可能把它放進自己的框架。回應自己帶 `Content-Type`（上傳時從檔頭判斷的型別）、`Content-Disposition: inline`、`Content-Security-Policy: default-src 'none'`、`Cache-Control: private, max-age=<到網址到期>, immutable`（`e13-t13`） |

**網頁的 CSP**（`PAGE_CSP`）只允許這個網站用到的東西：

| 指令 | 值 | 為什麼 |
| --- | --- | --- |
| `default-src` | `'self'` | 其他沒列的都只能來自本站 |
| `script-src` | `'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com` | Vite 產物都是外部檔案（`index.html` 沒有行內 script）；DDS（`bridge-dds`）在 Web Worker 裡用 `WebAssembly.instantiate` 編譯內嵌的 WASM，需要 `'wasm-unsafe-eval'`（不是 `'unsafe-eval'`）；Cloudflare Turnstile 的 script（`e1-t33`，`TURNSTILE_ORIGIN`），只在申請加入、而且 Worker 給了 site key 時才載入 |
| `style-src` | `'self' 'unsafe-inline'` | styled-components 插 `<style>`、React 的 `style` 屬性；只開給樣式，script 沒有 `'unsafe-inline'` |
| `img-src` | `'self' data: blob:` | 頭像與圖片都是本站的 `/api/avatar/`、`/api/files/`；裁切頭像、分享卡用 `blob:` |
| `font-src` | `'self' data:` | Noto Sans TC 隨網站打包；小檔可能被 Vite 內嵌成 `data:` |
| `frame-src` | `https://challenges.cloudflare.com` | Turnstile 在 iframe 裡做驗證（`e1-t33`）；其他網站一律不能被框進來 |
| `connect-src` | `'self'` | API 與 WebSocket 都在本站（CSP Level 3 的 `'self'` 也涵蓋同主機的 `wss:`）；淡江橋館走它自己的網域（Vercel 轉發），不需要放行 |
| `worker-src` | `'self' blob:` | DDS 的 Web Worker、Service Worker（`sw.js`） |
| `object-src`／`base-uri`／`form-action`／`frame-ancestors` | `'none'`／`'self'`／`'self'`／`'none'` | 不能嵌入別的網站、不能被別的網站框住 |

**Google 登入（`e1-t31`）與 LINE 登入（`e1-t32`）不用改 CSP**（LINE 是整頁前往 `access.line.me`、導回 `/api/auth/line/callback`，同一個道理；兩個按鈕的 logo 都是頁面裡的 SVG，不載入外部圖片）：整個流程是整頁導向，不是頁面裡的請求。頁面用 `fetch` 呼叫本站的 `POST /api/auth/google/start`（`connect-src 'self'`），再用 `location.assign` 整頁前往 `accounts.google.com`；Google 把瀏覽器導回本站的 `/api/auth/google/callback`，伺服器用 302 轉回本站的相對路徑。CSP 沒有限制整頁導向的指令（`navigate-to` 從未被瀏覽器實作），也沒有表單送到 Google（`form-action 'self'` 不受影響），不載入 Google 的 script、iframe、圖片（不用 Google Identity Services 的按鈕，頭像也不存不顯示），所以 `PAGE_CSP` 與 `public/_headers` 都沒變。callback 的回應是 `/api/*`，帶 `API_HEADERS`（`sandbox`）也無妨：302 沒有內容可執行。`Cross-Origin-Opener-Policy: same-origin` 只影響彈出視窗，這裡沒有彈出視窗。淡江橋館的 Vercel 沒有設 CSP。

**PWA 推播（`e1-t28`）也不用改 CSP**：頁面只呼叫本站的 `/api/push*`（`connect-src 'self'`）與瀏覽器內建的 `Notification.requestPermission`、`pushManager.subscribe`，訂閱時瀏覽器自己連它的推播服務，不受頁面的 CSP 管。Service worker 還是本站的 `/sw.js`（`worker-src 'self'`），它的 `fetch`（推播服務換了訂閱時送回 `/api/push/subscribe`）是本站；通知的圖示是本站的 `/icon-192.png`。送推播是社團的 Durable Object 對推播服務發的請求，跟頁面無關。所以 `PAGE_CSP` 與 `public/_headers` 都沒變。

**開發模式不受影響**：`@cloudflare/vite-plugin` 在 `npm run dev` 只有開實驗選項才套用 `_headers`，所以 Vite 的行內 HMR script 照常；`npm run build` 後 `dist/client/_headers` 才生效（`vite preview`、預覽站、正式站）。

**檢查方式**：PR 預覽站或正式站

```bash
curl -sI https://<網站>/ | grep -iE 'content-security|x-frame|strict-transport|referrer|permissions'
curl -sI https://<網站>/api/health | grep -iE 'content-security|x-frame|nosniff'
```

再用瀏覽器開大廳、開一桌打幾張牌、開紀錄頁的雙明手分析（DDS）、上傳頭像、下載我的資料，開發者工具的 Console 不應有 `Content Security Policy` 的錯誤。新加外部資源（字型 CDN、分析工具）時要先改 `PAGE_CSP` 並重新產生 `public/_headers`：

```bash
npx tsx -e "import {headersFile} from './worker/security-headers.ts'; process.stdout.write(headersFile())" > public/_headers
```

## 3. ASVS Level 1 對照

### V2 驗證

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| 2.1.1 密碼至少 12 字 | ✅ | `e11-t29`（社長 2026-11-02 決定）：`LIMITS.passwordMin` 12（之前 6）。只檢查**新設定**的密碼：申請加入、管理員新增帳號、改密碼、管理員重設、忘記密碼的重設（`worker/password-policy.ts` 的 `checkNewPassword`）；現有帳號用舊的短密碼照樣登入，不強迫改。規則在伺服器判斷，表單的 `minLength` 與提示（`passwordHint`）只是提示 |
| 2.1.2 允許至少 64 字、最多 128 字 | 🔧 | 新增 `LIMITS.passwordMax` 128（`longPassword`），之前沒有上限 |
| 2.1.7 檢查外洩密碼 | ✅ | `e11-t29`：`worker/common-passwords.ts` 是 1,197 個外洩密碼——NCSC 從 Have I Been Pwned 整理的最常用 100,000 個裡，長度 12–128 的那些（短的反正會被長度擋掉），轉小寫、去重，約 20 KB。來源：SecLists（`Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt`，MIT License，Copyright (c) 2018 Daniel Miessler）；用 `scripts/common-passwords.ts` 重新產生。另外擋本站的字（`tkubridgetable` 等）與同一個字元重複（`commonPassword`）。查詢是第一次用時建一個 `Set`、之後 `Set.has`，在社團的 Durable Object 裡做；不呼叫外部服務（CSP 只放行本站，密碼也不該送出去）。也擋跟帳號名稱相同或包含帳號名稱（不分大小寫；2 個字的帳號只擋相同，否則太多密碼會被誤擋）的密碼（`passwordHasUsername`）。沒有做 k-anonymity 的 Pwned Passwords API：要放行外部連線，且清單已涵蓋最常見的 |
| 2.2.1 防暴力猜測 | ✅ | `worker/rate-limit.ts`：同一來源＋帳號 15 分鐘 5 次、同一來源 20 次（`tooManyLogins`） |
| 申請加入的防濫用（11.1.4 防自動化） | 🔧 | `e1-t33`：同一來源一小時 10 次申請或錯的邀請碼（`worker/register-limit.ts`，429 `tooManyRegistrations`），位址只存以 `SEEN_SALT` 加鹽的雜湊、一小時後清掉，沒設 `SEEN_SALT` 時只在記憶體；Cloudflare Turnstile（`worker/turnstile.ts`）設了 site key 與 secret 才開，伺服器向 `siteverify` 驗證、連不到時不放行（403 `captchaFailed`）。「忘記密碼」申請沒套：已經每人只通知一次、要邀請碼；Email 重設（`e1-t30`）時再加（ARCHITECTURE.md §5.2） |
| 2.4.1 密碼雜湊 | 🔧⚠️ | `e11-t30`：PBKDF2-SHA-256 加鹽，新雜湊 100,000 次（之前 50,000），舊雜湊在下次登入成功時重算（`needsRehash`）。**100,000 是 Cloudflare 執行環境 PBKDF2 的上限**（多了會被拒絕），OWASP 建議的 600,000 次在 Workers 上做不到；量測（2026-10-30，Node）：50,000 次 6 ms、100,000 次 12 ms、600,000 次 65 ms。雜湊在社團的 Durable Object 裡算，不佔 Worker 每次請求的 10 ms，登入有次數限制。要更強只能換演算法（Argon2 要 WASM，CPU 更多），目前不做 |
| 全形字元（社長 2026-11-03） | ✅ | 中文／日文輸入法在全形模式打出的 ＡＢＣ１２３ 一律當成 ABC123（`shared/halfwidth.ts`：U+FF01–U+FF5E 轉 U+0021–U+007E、U+3000 轉空白，其他字不動）。**前端**：帳號、密碼、邀請碼、重設代碼、兩步驟代碼與信箱欄位（`CredentialInput`、`PasswordInput`，共用 `src/lib/useHalfWidth.ts`）邊打邊轉，選字中不動、選字結束再轉，並標 `lang="en"`、`autoCapitalize/autoCorrect="off"`、`spellCheck={false}`。**伺服器**：帳號、邀請碼、代碼、信箱查詢前先轉；新密碼（申請、改密碼、兩種重設、管理員新增或重設）一律存半形的雜湊（`hashPassword`）。**舊密碼**：之前存的密碼可能含全形字，而現在的頁面送來的已是半形，所以登入與每次再確認密碼（改密碼、綁定與解除 Google／LINE、信箱、兩步驟、刪除帳號）用 `matchPassword`：先比半形，不對再比原樣送來的字，再比整串轉全形（輸入法整段都在全形模式，最常見）；舊形式比中時登入會改存半形的雜湊，之後兩種打法都能登入。只有部分字元全形的舊密碼兩者都比不中，要請管理員或用信箱重設。打錯密碼最多算三次雜湊（約 36 ms，在 Durable Object 裡，登入有次數限制）。帳號名稱以前允許全形字母：先找完全相同（不分大小寫）的帳號，沒有才比半形，舊帳號用兩種打法都找得到；新帳號存半形，跟既有帳號只差全形半形的算重複 |
| 2.5.x 忘記密碼 | 🔧 | `e1-t36`：邀請碼只能**送出申請**（通知管理員），管理員核准後才產生一次性代碼（約 49 bit、3 天、用一次、只存雜湊），只顯示給核准的管理員，由他交給確認過的本人；代碼與新密碼才能重設，錯的代碼與登入共用失敗次數限制。重設後登出所有裝置（session、通行證、連線）。管理員帳號仍只能由其他管理員重設。剩下的風險：管理員沒確認本人就把代碼交出去（DEPLOY.md 寫明要確認）。**Email 重設**（`e1-t29`、`e1-t30`，ARCHITECTURE.md §5.20）：只有驗證過 Email 的帳號能用；連結的權杖 256 bit、30 分鐘、用一次、只存 SHA-256，放在網址的 `#` 後（不進伺服器紀錄），打開頁面不會用掉要按按鈕；不論帳號或 Email 存不存在回答都一樣；每個帳號 10 分鐘 1 封、每個 IP 2 分鐘 1 次申請，錯的連結與登入共用失敗次數限制；設好後登出所有裝置。綁定 Email 要輸入密碼，驗證連結 24 小時、用一次。沒設寄信服務時整個關掉（`emailOff`） |
| 第三方登入（Google `e1-t31`、LINE `e1-t32`） | 🔧 | OpenID Connect 授權碼流程，全部在伺服器（ARCHITECTURE.md §5.2、`worker/oauth.ts`、`worker/google.ts`、`worker/line.ts`），兩者同一套流程與規則；LINE 另外以 Channel secret 驗 ID token 的 HS256 簽章（只收 `HS256`），只要 `openid profile`、不要 Email：`state` 與 HttpOnly cookie `tbt_google`（`Path=/api/`、`SameSite=Lax`）比對，擋登入 CSRF；PKCE S256 與 `nonce` 綁住這一次流程；流程紀錄用一次就刪、10 分鐘過期。code 由社團的 Durable Object 帶 client secret 到 Google 的 token endpoint 換 ID token，依 OIDC Core §3.1.3.7(6) 以 TLS 代替簽章檢查（直接從 token endpoint 拿到的 token），仍檢查 `iss`、`aud`／`azp`、`exp`、`iat`、`nonce`、`email_verified`。**用 `sub` 認人，從不用 Email**（別的 Google 帳號就算宣稱同一個 Email 也不是同一個人）。Google 只能綁到既有帳號：綁定要先輸入密碼、callback 時還要是同一個人登入著；解除也要密碼，而每個帳號都有密碼（用 Google 申請也要設），不會把自己鎖在外面。**Google 不取代兩步驟登入**：有開的帳號回來後還要驗證碼（同一個 `secondStep` 與失敗次數）。用 Google 申請照樣要帳號名稱、邀請碼、Turnstile、同 IP 次數與管理員核准。只導回本站與淡江橋館的網址（`oauthSite`、`safeReturn`），不是開放式轉址。同一個 IP 一分鐘 1 次（可連續 10 次）開始流程、同時最多 500 筆流程。兩個 secret 都設才開；client secret 只在 Worker secret |
| PWA 推播（`e1-t28`） | 🔧 | Web Push 只用 WebCrypto（`worker/web-push.ts`）：內容依 RFC 8291 端對端加密（每則新的 ECDH 金鑰與 salt，推播服務看不到內容），VAPID（RFC 8292，ES256）證明是本站送的；私鑰只在 Worker secret `VAPID_PRIVATE_KEY`，三個 secret 都設才開。**SSRF**：訂閱的 endpoint 只接受 `https`、沒有帳密與埠號、主機是瀏覽器的推播服務（FCM、Mozilla、WNS、Apple，`allowedEndpoint`），最長 1024 字；`p256dh`／`auth` 檢查長度。每人最多 10 台裝置、測試推播 10 秒一次。endpoint 與金鑰是只有那台瀏覽器該知道的能力網址，**不回給頁面、不在匯出資料裡**（列表只用 endpoint 的雜湊當 id）。推播內容跟鈴鐺一樣（對方帳號名稱、桌號、貼文標題），會出現在鎖定畫面；不推私訊。在線（有連線）時不推。登出時先刪掉這台裝置的訂閱，被登出所有裝置時清掉全部裝置，帳號刪除時整筆刪（ARCHITECTURE.md §5.4） |
| 2.7／2.8 多因素 | 🔧 | `e11-t31`：管理員可開「兩步驟登入」（TOTP，RFC 6238：SHA-1、6 位數、30 秒，前後各容許一步；`worker/totp.ts` 只用 WebCrypto）。同一步的驗證碼只能用一次（記住 `lastStep`）；10 組一次性備用碼只存 SHA-256；驗證碼錯 5 次鎖那個帳號 15 分鐘（不分來源，`TWO_FACTOR_FAILURES`），同時算進那個 IP 的登入失敗次數；鎖住、用了備用碼、被關掉時寄通知到驗證過的 Email。金鑰要能算出驗證碼，所以跟密碼雜湊一樣原樣存在 `user:<id>`（備份裡也有），匯出資料不含金鑰與備用碼雜湊。**管理員一定要開**（社長 2026-11-02）：沒開的管理員能登入，但所有管理員與權限才能用的 API 都回 403 `adminTwoFactorRequired`（伺服器判斷，ARCHITECTURE.md §5.2）。設定頁的 QR code 在頁面裡用 `qrcode-generator`（MIT，打包進來）畫成 SVG，金鑰不送到別的服務 |

### V3 Session

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| 3.2.1／3.2.2 登入後換新 token、128 bit 以上隨機 | ✅ | 每次登入新的 256 bit token（`randomId(32)`，`crypto.getRandomValues`） |
| 3.3.1 登出讓 session 失效 | ✅ | `POST /api/logout` 刪掉 `session:<token>` 並清 cookie |
| 3.3.3 改密碼後可以登出其他 session | ✅ | 「登入中的裝置」卡（`GET /api/account/sessions`、`DELETE /api/account/sessions/:id`、`POST /api/account/sessions/others`）；改密碼時也自動登出其他裝置。`e11-t28` 起連邊緣通行證與牌桌的連線也一起失效 |
| 3.4.1～3.4.3 cookie 屬性 | ✅ | `tbt_session`、`tbt_pass`、`tbt_device`（瀏覽器 id，不是登入憑證，防作弊報表用，ARCHITECTURE.md §5.17）都是 HttpOnly、SameSite=Lax、Path=/，HTTPS 時加 Secure |
| 3.4.4 `__Host-` 前綴 | 📋 | 沒用。改名會讓全部人（含淡江橋館經 Vercel 轉發的登入）重新登入一次，`e11-t28` 沒一起做，留給社長決定時間（§4） |
| 3.7.1 重要操作再驗證 | ✅ | 改密碼要目前的密碼；刪除帳號要密碼＋確認 |
| 邊緣通行證的撤銷窗口 | 🔧 | `e11-t28`：通行證帶 session id（`pass2` 格式）；session 結束時社團把 id 寫進 D1 的 `pass_revocations`，Worker 每次靠通行證回答前先查，**登出後下一個請求就不認**；同時關掉那個人在牌桌的連線（`TableApi.signOut`）。沒有 D1（PR 預覽）或查詢失敗時 Worker 不認通行證、改問社團（ARCHITECTURE.md §5.12） |

### V4 存取控制

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| 4.1.1～4.1.3 伺服器端檢查、最小權限 | ✅ | 規則與權限只在 `ClubService`／`worker/roles.ts`；前端只看 `legalCalls`／`legalCards`；管理路由 `adminRouteNeed` |
| 4.2.1 不能用 id 讀別人的東西 | ✅ | 可見性集中在 `worker/views.ts`，`tests/worker/visibility/` 回歸測試；session 列表與登出只看自己的（`endSession` 對別人的 id 一律 404） |
| 論壇圖片（`e13-t13`） | ✅ | 貼文只能放自己上傳的圖片（`forumImageNotYours`）；`POST /api/files/urls` 只替上傳者、或看得到用這張圖的貼文的人簽 `post/` 的網址，所以幹部隱藏貼文後別人拿不到新網址，已發出的最多兩小時內失效；刪貼文或編輯拿掉圖片時，沒有其他貼文用的就從 R2 刪掉（`worker/post-images.ts`，ARCHITECTURE.md §5.14） |
| 4.3.1 管理介面多因素 | ✅ | 見 2.7（`e11-t31`）：沒開兩步驟登入的管理員在伺服器上只算一般社員（`ClubService.actsAsAdmin`、`roles.ts` 的 `adminLocked`），管理頁只顯示「先去開啟」的橫幅；淡江橋館的管理功能走同一支 API，一樣擋。只有一位管理員又遺失手機與備用碼時，由 Cloudflare 帳號的擁有者用臨時的 `TWO_FACTOR_RESET_TOKEN` 清掉（DEPLOY.md §4.15）：這個 secret 平常不存在，路由回 404，不是網頁上的後門 |

### V5 輸入驗證與輸出編碼

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| 5.1.x 輸入驗證 | ✅ | WebSocket：`shared/message-guard.ts`（型別、8 KB 上限）；HTTP：各 `parse*`（個人檔案、練習設定、牌桌設定…）、未知欄位擋掉 |
| 5.1.4 本文大小 | 🔧 | `e11-t32`：`worker/body.ts` 邊讀邊算，`Content-Length` 只當提示：超過就不讀，沒有或說謊的讀到超過的那一塊就停、取消上傳。JSON 2 MB、錯誤回報與橋館統計、頭像 64 KB、圖片與電子書各自的上限、AI 匯入的表單（PDF 上限＋1 MB）全部適用 |
| 5.3.x 輸出編碼、XSS | ✅ | React 自動跳脫；全站沒有 `dangerouslySetInnerHTML`；新的 CSP 再擋一層 |
| 5.5.x 反序列化 | ✅ | 只有 `JSON.parse`，結果再經型別守衛 |

### V7 錯誤與日誌

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| 7.1.1 不記密碼與 token | ✅ | `worker/log.ts` 的結構化日誌只有事件、路徑（不含查詢字串）、狀態與代碼；刪帳號只記 `accountDeleted`，不記是誰 |
| 7.4.1 錯誤不洩漏內部資訊 | ✅ | 未預期的錯誤一律回 `serverError`，細節只進日誌 |

### V8 資料保護

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| 8.2.1 敏感回應不快取 | ✅ | API 的 JSON 一律 `Cache-Control: no-store` |
| 8.3.1 敏感資料不放網址 | ✅ | session 在 cookie；上傳憑證與簽名網址是一次性、有期限 |
| 8.3.2 使用者可以匯出、刪除自己的資料 | 🔧 | `e11-t27`：`GET /api/account/export`、`POST /api/account/delete`（§5） |

### V9 傳輸

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| 9.1.1 全站 TLS | ✅ | Cloudflare 只走 HTTPS；🔧 加上 HSTS |

### V10 惡意程式碼／V14 設定

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| 10.3.2 第三方資源 | ✅ | 沒有 CDN、沒有分析或廣告程式；字型隨網站打包。唯一的外部 script 是 Cloudflare Turnstile（`e1-t33`），只在申請加入、開了 Turnstile 時載入；它必須從 Cloudflare 載入（官方不支援自己放），所以沒有 SRI |
| 14.2.1 相依套件 | ✅ | 2026-10-30 `npm audit --omit=dev`：0 個漏洞。2026-11-02 加 `qrcode-generator`（MIT，作者 Kazuhiko Arase，沒有相依套件，只在瀏覽器畫 QR code）。Dependabot 的 undici 警示（high，`< 7.30.1`，經 `wrangler`／`@cloudflare/vite-plugin` 的 miniflare，只在開發與部署工具）：升到 wrangler 4.156、vite-plugin 1.66 後 undici 7.30.1，`npm audit` 全部 0 個 |
| 14.4.x 安全標頭 | 🔧 | §2 |
| 14.5.3 CORS | ✅ | 只有不靠 cookie 的路由開 `Access-Control-Allow-Origin: *`：簽名上傳、AI 匯入（帶一次性憑證）、簽名的檔案網址；其餘 API 沒有 CORS，淡江橋館經 Vercel 同網域轉發 |
| 祕密 | ✅ | `INVITE_CODE`、`ANTHROPIC_API_KEY`、`EDGE_AUTH_SECRET`、`SEEN_SALT`、`TURNSTILE_SECRET_KEY` 等都是 `wrangler secret`；`TWO_FACTOR_RESET_TOKEN` 只在救援時臨時設、用完就刪（DEPLOY.md §4.15），staging 與預覽站各自一套（DEPLOY.md）。`SEEN_SALT` 是防作弊報表網路雜湊的鹽，刻意不放在社團儲存裡：拿到儲存或備份也無法窮舉 IPv4 還原登入位址（ARCHITECTURE.md §5.17）；沒設時不記網路 |

### V12 檔案／V13 API

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| 12.1.1 上傳大小 | ✅ | 頭像 64 KB、圖片 2 MB、縮圖 256 KB、電子書 50 MB，超過 413；每人每天 30 張圖片（`fileDailyLimit`），R2 全部 10 GB（`fileStorageFull`） |
| 12.2.1 檔案型別 | ✅ | 看檔頭的 magic bytes，不信 `Content-Type`；Worker 不解碼圖片。JPEG、PNG、WebP，貼文另可 GIF（`e13-t13`）；SVG 一律不收（可能帶 script）。照片在瀏覽器用 canvas 重畫後才上傳，拍攝地點等 EXIF 不會進 R2（GIF 原樣上傳，GIF 沒有 EXIF） |
| 13.2.3 CSRF | ✅ | cookie 是 SameSite=Lax，跨站的 POST／PUT／DELETE 不帶 cookie；`workers.dev` 在 Public Suffix List 上，別人的 `*.workers.dev` 不算同站 |
| 跨站 WebSocket（CSWSH） | 🔧 | `/ws` 與 `/ws/table/*` 的 `Origin` 必須是本站（`worker/routing.ts`），別的網站的頁面開不了；沒有 `Origin` 的非瀏覽器用戶端（負載測試）照舊 |
| 速率限制 | ✅ | 每個連線的動作、聊天、錯誤回報、使用統計各有 token bucket（`worker/rate-limit.ts`） |
| 公開分享連結（`e4-t38`） | ✅ | 唯一不用登入就讀得到牌的 API（`GET /api/share/:token`）：token 是 128 位元亂數；每個網路位址一個 token bucket（一次 30、之後每 2 秒一個），查錯 15 分鐘內 10 次就擋 15 分鐘（`slowDown`）；只回那一副已公開、打完的牌，欄位一個一個挑（`worker/views.ts` 的 `sharedBoardView`），沒有任何 id；只有產生連結的社員顯示名字（他設了「不公開打過的牌局」也不顯示），其他真人一律是「社員」；連結不過期、可隨時撤銷；回應帶 `X-Robots-Tag: noindex`。頁面 `/share/<token>` 是一般的 SPA 頁面，CSP 不用改。網址裡的 token 不會隨 Referer 送到別的網站（`Referrer-Policy: strict-origin-when-cross-origin` 跨站只送網域）。可見性與誰能產生、撤銷見 ARCHITECTURE.md §4 |

## 4. 待辦清單

每項都在 `docs/PRD/e11-platform-ops-scale.md` 開了 task：

| Task | 內容 | 風險 | 需要決定 |
| --- | --- | --- | --- |
| `e11-t28` | ✅ 邊緣通行證帶 session id、撤銷清單在 D1、那一桌的連線立刻關（V3）。`__Host-` 前綴沒做：會讓全部人重新登入 | 低 | 社長：要不要、什麼時候讓大家重新登入一次 |
| `e11-t29` | ✅ 最短 12 字、擋外洩密碼與包含帳號名稱的密碼，只套用新設定的密碼（V2.1） | — | — |
| `e11-t30` | ✅ 100,000 次（Cloudflare 上限），登入時升級（V3） | — | — |
| `e11-t31` | ✅ 管理員的兩步驟登入（TOTP＋備用碼；DEPLOY.md §4.15）。2026-11-02 社長決定：**管理員一定要開**（伺服器擋所有管理功能，回 `adminTwoFactorRequired`）、設定頁加 QR code（`qrcode-generator`，頁面裡畫 SVG）、只有一位管理員時由 Cloudflare 帳號擁有者用臨時 secret `TWO_FACTOR_RESET_TOKEN` 清掉；淡江橋館登入頁加驗證碼欄位（橋館的 PR，在牌桌部署後合併） | 低 | — |
| `e11-t32` | ✅ `worker/body.ts`（V3） | — | — |
| `e1-t36` | ✅ 忘記密碼改成管理員核准、一次性代碼（V3）；Email 重設（`e1-t30`）在全台灣清單最後 | 低 | — |
| `e1-t28` | ✅ PWA 推播：Web Push 自己用 WebCrypto 做（RFC 8291／8292，不用 Node 套件），endpoint 只准推播服務、在線不推、失效的訂閱自動刪（DEPLOY.md §4.17） | 低 | 社長：用 `npm run vapid` 產生金鑰、設三個 secret；推播在鎖定畫面會顯示對方名稱與貼文標題，要不要改成只顯示「你有新通知」（目前顯示內容） |
| `e1-t31` | ✅ Google 登入：綁在既有帳號上的另一種登入方式、用 Google 申請仍要核准、兩步驟登入照樣要驗證碼（DEPLOY.md §4.16） | 低 | 社長：在 Google Cloud 建 OAuth client、設兩個 secret；用 Google 申請要不要也免設密碼（目前要設） |
| `e1-t32` | ✅ LINE 登入：與 Google 同一套（綁定、申請、兩步驟登入），ID token 驗 HS256 簽章，不要 Email（DEPLOY.md §4.18） | 低 | 社長：在 LINE Developers 建 LINE Login channel、設 Callback URL、公開、設兩個 secret |
| `e1-t33` | ✅ 申請加入：同一來源的次數限制、Cloudflare Turnstile（預設關，DEPLOY.md §4.13） | 低 | 社長：要不要打開 Turnstile（淡江橋館要先帶 token）；一小時 10 次夠不夠招生活動用 |

## 5. 個人資料：匯出與刪除（`e11-t27`）

- **匯出**：「我的帳號」→「下載我的資料」，`GET /api/account/export` 回一個 JSON 檔（`format: 'tku-bridge-table-account'`、`version`）：帳號與設定（不含密碼雜湊）、登入中的裝置、登入與連線紀錄（`signIns`：網路的雜湊（以 Worker secret `SEEN_SALT` 加鹽，不含 IP；沒設 secret 時是空的）、瀏覽器 id 與名稱、時間，防作弊報表用，ARCHITECTURE.md §5.17）、好友與封鎖、通知、私訊、練習設定、收藏與筆記、社團積分明細與實力評分（`points`、`rating`，ARCHITECTURE.md §5.21）、挑戰討論串的留言（`challengeComments`，§5.5）、自己產生過的公開分享連結（`boardShares`：哪一副、何時，`e4-t38`）、打過的每副牌的摘要（完整紀錄在 `/history/<id>`）、自己上傳過的圖片清單（`files`：key、型別、大小、上傳時間，不含圖片本身；圖片用貼文頁或 `POST /api/files/urls` 拿，`e13-t13`）。帳號裡有 Email（`email`、`emailVerifiedAt`，等待驗證的地址是 `emailPending`，`e1-t29`），不含驗證或重設連結的雜湊；綁了 Google 時有 `google`（Google 帳號的 `sub`、綁定當時的 Email、綁定時間，`e1-t31`），綁了 LINE 時有 `line`（LINE 的 `sub`、綁定當時的 LINE 名字、綁定時間，`e1-t32`），進行中的流程（`google:<id>`、`line:<id>`，最多 30 分鐘）不在裡面。開了推播時有 `push`：每台裝置的名稱與開啟時間、每個種類推不推（`e1-t28`），沒有推播服務的網址與金鑰。不含別人的 session 或任何 token。
- **刪除**：「我的帳號」→「刪除帳號」，要密碼與確認；`POST /api/account/delete` 走與管理員刪帳號相同的 `removeMember`：帳號（含 Email 與寄出的連結、Google 與 LINE 的綁定）、頭像、session、推播的裝置與偏好（`push:`）、登入與連線紀錄（`seen:`）、好友與封鎖、通知、私訊、收藏、練習設定、閱讀與學習進度、社團積分與實力評分（§5.21）、挑戰討論串的留言、自己產生的公開分享連結（`e4-t38`）、每天上傳張數的計數立即刪除，所有連線關閉。**論壇圖片**（`e13-t13`）：沒有任何貼文在用的（上傳了沒發、或貼文已刪）從 R2 刪掉；還在自己貼文裡的跟著貼文保留（貼文刪掉時一起刪）。刪帳號由 `ClubService` 的 `onMemberRemoved` 通知 `Club` 處理，管理員刪帳號、還原備份時少掉的帳號也一樣；R2 出錯不會擋住刪帳號（記 log，圖片留著）。社團唯一的管理員不能刪（`lastAdminLeaving`）。
- **保留的**：打過的牌局紀錄是同桌其他人的紀錄，保留帳號名稱；論壇與淡江橋館的文章與留言保留（隱私權政策請社員先自己刪），貼文裡的圖片也是；叢書文章的圖片與電子書是叢書的，不刪；備份裡的帳號在 30 天內隨備份到期消失。
- **政策頁**：`/privacy`、`/terms`（不用登入，`src/pages/LegalPage.tsx`，文字在 `strings.ts` 的 `legal`，六種語言）。登入頁與「我的帳號」底下有連結；註冊時寫「註冊即表示同意」。內容改了要改 `LEGAL_UPDATED`。
