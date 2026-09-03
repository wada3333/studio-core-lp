# STUDIO CORE ランディングページ

**公開ページ：<https://wada3333.github.io/studio-core-lp/>**

架空のパーソナルジム「STUDIO CORE」のLP制作実績です。
フレームワーク・外部ライブラリを一切使わず、HTML / CSS / バニラJavaScript のみで実装しています。

重点を置いたのは次の3点です。

1. **予約フォームの空き枠連携** — 非同期通信・状態の一元管理・エラー分岐・二重送信防止
2. **Lighthouse 4カテゴリすべて 100**（モバイル／デスクトップ）
3. **計測イベントの自前設計** — CTAクリック・スクロール到達率・フォーム離脱の追跡

---

## 目次

- [動かし方](#動かし方)
- [実装した機能](#実装した機能)
- [Lighthouse スコア（実測値）](#lighthouse-スコア実測値)
- [予約フォームの構成](#予約フォームの構成)
- [計測イベント一覧](#計測イベント一覧)
- [GAS側のセットアップ](#gas側のセットアップ)
- [使用技術](#使用技術)
- [デザイン方針](#デザイン方針)
- [画像素材と動画](#画像素材と動画)
- [テスト](#テスト)
- [ディレクトリ構成](#ディレクトリ構成)
- [既知の制約](#既知の制約)

---

## 動かし方

ビルド不要です。Node.js 20 以上があれば以下だけで動きます。

```bash
node tools/serve.mjs 8123
```

`http://127.0.0.1:8123/` を開いてください。
`tools/serve.mjs` は gzip 圧縮・長期キャッシュ・keep-alive を返す検証用の静的サーバーです
（依存パッケージなし）。本番相当の配信条件を再現するため、Lighthouse はこのサーバーに対して計測しています。

> 単にファイルを開く（`file://`）と `data/plans.json` の fetch が CORS で失敗し、
> 料金シミュレーターだけ動きません。必ず HTTP で配信してください。

### 動作確認用のクエリパラメータ

| URL | 挙動 |
|---|---|
| `?debug=1` | `dataLayer` に push した内容をコンソールに出力 |
| `?mock=error` | 空き枠取得・予約送信が通信エラーになる |
| `?mock=timeout` | 応答が返らず、10秒でタイムアウトする |
| `?mock=empty` | 空き枠ゼロの日として応答する |
| `?mock=conflict` | 送信時に必ず二重予約（conflict）になる |

`config.js` の `GAS_URL` が空のあいだは、`gas/Code.gs` と同じ応答を返すモックが自動で使われます。
そのためサーバーを用意しなくても、予約完了まで一通り動作します。

---

## 実装した機能

### 予約フォーム（最重要）

- 日付 → 空き時間 → お客様情報 の3STEP。日付を選ぶとサーバーへ空き枠を `GET`
- **ローディング状態** — 空き枠取得中・送信中それぞれに専用の表示（スピナー＋文言）
- **エラーハンドリング** — 通信失敗 / タイムアウト / 枠ゼロ / 二重予約 / 入力不備 を別々のメッセージと復帰導線で出し分け
- **二重送信防止** — 送信中はボタンを `disabled` にし、加えて状態フラグでも多重 POST を止める
- **タイムアウト** — `AbortController` で10秒。超過時は「まだ確定していない」旨を明示して再試行を促す（モックにも同じタイムアウトが掛かる）
- **バリデーション** — 日付（定休日・受付期間）／メール形式／電話番号形式／必須／文字数。エラーは各入力欄の直下に出し `aria-describedby` で関連付け
- **フォーカス管理** — STEP遷移時に新しく現れた見出しへフォーカスを移動。完了時は完了見出しへ
- **状態の一元管理** — `step / selectedDate / selectedTime / slots / loading / error / fieldErrors / submitted` を単一オブジェクトで保持し、DOM反映は `render()` に集約
- 日付を選び直すと進行中のリクエストを `abort()` し、後発の応答だけを採用（レースコンディション対策）

### 料金シミュレーター

- 週回数（1・2・3回）× 期間（3・6・12ヶ月）× オプション（食事／ストレッチ）× 入会金無料条件
- 計算ロジックは `js/simulator.js` に**純粋関数**として分離（DOM を一切参照しない）。Node からも読める形にしてユニットテスト済み
- 料金定義（単価・割引率・オプション・入会金）は `data/plans.json` に外出し。UIの選択肢も JSON から生成するので、料金改定は JSON の編集だけで完結
- 結果は「伝票」として表示（基準月額 → 割引 → プラン月額 → オプション → 1回あたり → 入会金 → 総額）

### 計測

- `window.dataLayer` への push を `js/analytics.js` に集約
- スクロール到達率は `scroll` イベントではなく **IntersectionObserver**（文書の高さに対する 25/50/75/100% の位置に高さ1pxの目印を置いて通過を検知）
- デバッグモードあり（`?debug=1`）

### UI

- ヒーロー背景動画 — 静止画の上に重ねてループ再生。**モバイル幅と `prefers-reduced-motion: reduce` では1バイトも読み込まない**（HTMLに `<video>` を書かず、条件を満たしたときだけJSで生成する方式）。読み込み開始は `load` 後のアイドル時間
- 追従CTA — ヒーローを抜けたら表示、予約フォーム到達で非表示。IntersectionObserver 制御。非表示時は `inert` でキーボードフォーカスと支援技術から外す
- FAQ は `<details>` / `<summary>` のネイティブ実装（JSなし・キーボード操作可）
- `prefers-reduced-motion: reduce` でアニメーションとスムーススクロールを無効化

---

## Lighthouse スコア（実測値）

Lighthouse 12.8.2 / Chrome ヘッドレス / `tools/serve.mjs` 配信。
**5回実行した中央値**です（`node tools/lighthouse-run.mjs 5`）。

### モバイル（デフォルトプリセット：4x CPUスロットリング・Slow 4G）

| カテゴリ | スコア |
|---|---|
| Performance | **100** |
| Accessibility | **100** |
| Best Practices | **100** |
| SEO | **100** |

| 指標 | 実測値（中央値） |
|---|---|
| First Contentful Paint | 0.9 s |
| Largest Contentful Paint | 1.4 s |
| Total Blocking Time | 30 ms |
| Cumulative Layout Shift | 0 |
| Speed Index | 0.9 s |

### デスクトップ（`--preset=desktop`）

| カテゴリ | スコア |
|---|---|
| Performance | **100** |
| Accessibility | **100** |
| Best Practices | **100** |
| SEO | **100** |

FCP 0.2s / LCP 0.5s / TBT 0ms / CLS 0 / SI 0.3s（ヒーロー動画を読み込んだ状態での計測）

生レポートは `lighthouse-report.json`（モバイル）・`lighthouse-report.html`・`lighthouse-desktop.json` に含めています。

> **計測環境について**：モバイルのスコアは計測マシンのCPU負荷に強く影響されます。
> 上記は Lighthouse の `benchmarkIndex` が 2,900 前後（＝マシンが空いている状態）での値です。
> 同じコードでも他アプリがCPUを使っている状態（benchmarkIndex 670 前後）では
> TBT が 4倍に膨らみ Performance が 83 まで落ちました。
> 再計測の際は `benchmarkIndex` を併せて確認してください（`tools/lighthouse-run.mjs` が各実行で出力します）。

### 実施した最適化

| 施策 | 効果 |
|---|---|
| Critical CSS のインライン化＋残りを非同期読み込み | レンダーブロッキング 0 |
| **ファーストビュー外セクションの `content-visibility: auto`**（実測値ベースの `contain-intrinsic-size` 付き） | 初期レイアウトと再レイアウトの範囲を画面内に限定。TBT を大幅に削減 |
| **ファーストビュー直下（共感パート）のスタイルも Critical CSS に含める** | 非同期CSS到着時の再レイアウトで組み直しが発生しないようにした |
| Webフォントを使わない（システムフォント＋等幅の2系統） | フォント要求 0 件。subset化の必要自体をなくした |
| 詰め組み（`font-feature-settings: "palt"`）を見出しと数値のみに限定 | 本文全体の再シェーピングコストを回避 |
| 全画像 WebP・`width`/`height` 明示・ファーストビュー外は `loading="lazy"` `decoding="async"` | CLS 0 |
| ヒーロー画像を `<link rel="preload" fetchpriority="high">`＋`imagesrcset` | LCP 短縮。プリロードと `srcset` の選択結果を一致させている |
| ヒーロー画像を 800 / 1200 / 1600px の3サイズで配信（`srcset` + `sizes="100vw"`） | モバイルは 25KB で済む。LCP 2.2s → 1.4s |
| 生成画像（JPEG 計19MB）を WebP へ変換・リサイズ | 画像9点で計 **440KB**（1点あたり22〜82KB） |
| ヒーロー動画はモバイル・`prefers-reduced-motion` では読み込まない。PCでも `load` 後に遅延生成 | LCP・TBT に影響を与えない |
| gzip 配信・静的アセットに `max-age=31536000, immutable` | 転送量とキャッシュ効率 |
| JavaScript は全て `defer`、外部ライブラリ 0 | パース・実行コストの最小化 |
| SVG favicon を設置 | `/favicon.ico` の 404 によるコンソールエラーを解消（Best Practices 100 の要件） |

---

## 予約フォームの構成

### フロー

```
                    ┌─────────────────────────────────────────┐
                    │ STEP 1  日付を選ぶ  <input type="date"> │
                    └────────────────┬────────────────────────┘
                                     │ change
                          ┌──────────▼───────────┐
                          │ 入力バリデーション    │──── NG ──▶ 欄下にエラー表示
                          │ 定休日 / 受付期間     │            form_error: validation
                          └──────────┬───────────┘
                                     │ OK
                    ┌────────────────▼─────────────────┐
                    │ GET {GAS_URL}?date=YYYY-MM-DD    │
                    │ AbortController 10秒             │
                    │ 進行中の前リクエストは abort()    │
                    └────────────────┬─────────────────┘
             ┌───────────────┬───────┴────────┬──────────────────┐
             │               │                │                  │
        通信失敗         タイムアウト       slots: []          slots: [...]
             │               │                │                  │
      「もう一度試す」  「10秒で中断」   「別の日付を」      ┌─────▼──────┐
       form_error:       form_error:      form_error:       │  STEP 2    │
        network           timeout          empty            │ 時間を選ぶ  │
                                                            └─────┬──────┘
                                                                  │ form_step: 2
                                                            ┌─────▼──────┐
                                                            │  STEP 3    │
                                                            │ 氏名/メール │
                                                            │ 電話/相談   │
                                                            └─────┬──────┘
                                                                  │ form_step: 3
                                                  ┌───────────────▼────────────────┐
                                                  │ submit                          │
                                                  │ 全項目バリデーション             │──NG──▶ 最初の不備欄へ
                                                  │ 送信中はボタン disabled          │        フォーカス移動
                                                  └───────────────┬────────────────┘        form_error: validation
                                                                  │
                                                  ┌───────────────▼────────────────┐
                                                  │ POST {GAS_URL}                  │
                                                  │ {date,time,name,email,tel,      │
                                                  │  message,token}                 │
                                                  └───────────────┬────────────────┘
                                     ┌──────────────┬─────────────┴───────┐
                                     │              │                     │
                              status:success   status:conflict         通信失敗/timeout
                                     │              │                     │
                              完了表示・予約番号  「別の時間を選ぶ」    「もう一度お試しください」
                              form_submit        form_error: conflict   form_error: network / timeout
                              完了見出しへフォーカス
```

### 状態管理

`js/booking.js` は次の1オブジェクトだけを真実とし、DOMへの反映は `render()` に閉じ込めています。

```js
var state = {
  step: 1,              // 1 | 2 | 3
  selectedDate: '',     // 'YYYY-MM-DD'
  selectedTime: '',     // 'HH:mm'
  slots: [],            // サーバーから取得した空き枠
  loading: { slots: false, submit: false },
  error: null,          // { scope, type, message, retry }
  fieldErrors: {},      // { date, time, name, email, tel, message }
  submitted: false,
  reservationId: '',
  token: '…'            // セッションごとに発行し POST に添える
};
```

`render()` は `renderSteps / renderSlots / renderSlotsStatus / renderFieldErrors / renderSummary / renderSubmit / renderDone` に分割しています。
空き枠の一覧は「中身が変わっていなければ DOM を作り直さない」実装にしてあります
（作り直すと選択中のラジオが消え、キーボード操作中のフォーカスが失われるため）。

### API

**GET**

```
GET  {GAS_URL}?date=2026-09-15
→   { "date": "2026-09-15", "slots": ["10:00","11:30","14:30","19:00"] }
```

**POST**

```
POST {GAS_URL}
body: { date, time, name, email, tel, message, token }
→    { "status": "success", "reservationId": "R-20260915-1030" }
→    { "status": "conflict" }
→    { "status": "error", "message": "…" }
```

営業時間 10:00〜21:00 を90分刻みで割ると、開始時刻は
`10:00 / 11:30 / 13:00 / 14:30 / 16:00 / 17:30 / 19:00` の7枠になります
（19:00開始で20:30終了。20:30開始は閉店を越えるため作りません）。水曜は定休日で空き枠ゼロを返します。

---

## 計測イベント一覧

すべて `window.dataLayer.push()` で送出します（`js/analytics.js`）。各イベントに `timestamp` が自動付与されます。

| イベント名 | 発火条件 | 付帯情報 |
|---|---|---|
| `cta_click` | `data-cta` を持つ要素のクリック | `location`: `hero` / `pricing` / `sticky` / `faq` |
| `scroll_depth` | 文書の 25 / 50 / 75 / 100% 到達（各1回） | `depth`: `25` / `50` / `75` / `100` |
| `simulator_use` | シミュレーターの値変更 | `frequency`, `months`, `options`（カンマ区切り、なしは `none`） |
| `form_step` | STEP遷移 | `step`: `1` / `2` / `3` |
| `form_error` | エラー表示 | `type`: `network` / `validation` / `conflict` / `timeout` / `empty` |
| `form_submit` | 予約の送信成功 | `date`, `time` |

> `form_error` の `type` は仕様書の3種（network / validation / conflict）に
> `timeout`（10秒超過）と `empty`（空き枠ゼロ）を加えています。
> 「通信は届いたが枠がなかった」離脱と「通信自体が失敗した」離脱は打ち手が違うため、
> 分けて計測したほうが改善に使えると判断しました。

### GTM / Clarity への接続

- `dataLayer` を使っているため、GTM のカスタムイベントトリガーにそのまま接続できます
- Microsoft Clarity のタグは `index.html` の末尾にコメントで用意してあります。`config.js` の `CLARITY_ID` を設定し、コメントを外すと有効になります
- `?debug=1` を付けると push の内容がコンソールに出力されます

---

## GAS側のセットアップ

1. **スプレッドシートを作る**
   Google スプレッドシートを新規作成し、URL の `/d/` と `/edit` の間にある ID を控えます。

2. **Apps Script プロジェクトを作る**
   スプレッドシートのメニューから「拡張機能 → Apps Script」を開き、`gas/Code.gs` の内容を貼り付けます。

3. **設定を書き換える**
   ```js
   var CONFIG = {
     SPREADSHEET_ID: '控えたID',
     SHEET_NAME: '予約一覧',
     ...
   };
   ```
   営業時間・定休日・受付期間は、フロント側の `config.js` の `BOOKING` と必ず同じ値にしてください。

4. **初期化を実行する**
   エディタ上で関数 `setup` を選んで実行します（初回は権限の承認が必要です）。
   シートと見出し行が作成されます。

5. **ウェブアプリとしてデプロイ**
   「デプロイ → 新しいデプロイ → 種類の選択：ウェブアプリ」

   | 項目 | 設定 |
   |---|---|
   | 次のユーザーとして実行 | 自分 |
   | アクセスできるユーザー | **全員** |

   発行された `https://script.google.com/macros/s/××××/exec` をコピーします。

6. **フロント側に設定**
   ```js
   // config.js
   window.SC_CONFIG = {
     GAS_URL: 'https://script.google.com/macros/s/××××/exec',
     ...
   };
   ```
   設定した時点でモックから実通信に切り替わります。

7. **確認**
   ブラウザで `{GAS_URL}?date=2026-09-15` を開き、`{"date":"2026-09-15","slots":[...]}` が返れば成功です。
   GASエディタの `testGetSlots` を実行してログで確認することもできます。

### GAS実装のポイント

- **二重予約の防止** — `LockService.getScriptLock()` で書き込み全体を排他し、ロック内で空き確認 → 追記を行います。埋まっていれば `{"status":"conflict"}` を返します
- **サニタイズ** — 制御文字と `< >` を除去、先頭の `= + - @` を削除（スプレッドシートの数式インジェクション対策）、項目ごとに文字数を制限
- **サーバー側バリデーション** — 日付形式・受付期間・定休日・時刻が営業枠にあるか・メール形式・電話形式・トークンの有無を再検証します（フロントの検証だけに依存しません）
- **CORS** — GASのウェブアプリはプリフライトを避ける必要があるため、POST は `Content-Type: text/plain;charset=utf-8` で JSON 文字列を送り、`e.postData.contents` で受けています
- **メール送信** — `CONFIG.SEND_MAIL` を `true` にすると予約者と管理者に確認メールを送ります（既定は `false`）
- 予約のキャンセルはシートの「ステータス」列を `キャンセル` にすると、その枠が再び空き枠として返ります

---

## 使用技術

| 分類 | 内容 |
|---|---|
| フロントエンド | **フレームワーク不使用**。HTML5 / CSS / バニラJavaScript（ES5相当の記法＋`fetch` / `AbortController` / `IntersectionObserver`） |
| ビルド | **なし**。トランスパイル・バンドル・パッケージ依存ともにゼロ |
| CSS | カスタムプロパティ、Grid / Flexbox、`content-visibility`、`color-mix()`。プリプロセッサ不使用 |
| フォント | Webフォントなし。システムフォント（日本語）＋等幅フォントの2系統 |
| バックエンド | Google Apps Script + スプレッドシート |
| 計測 | `window.dataLayer`（GTM互換）／Microsoft Clarity の設置箇所を用意 |
| テスト | Node.js 標準の `node:test`（料金計算のユニットテスト12件）＋ CDP直叩きのE2Eスクリプト |
| 計測ツール | Lighthouse 12（`tools/lighthouse-run.mjs` で複数回実行して中央値を算出） |

`node_modules` はありません。`package.json` も不要です。

---

## デザイン方針

パーソナルジムのLPで定番の「ビフォーアフター写真を大量に並べた縦長」「煽り」「数字の圧」は避け、
**「静かで、続けられそうに見える」**ことを優先しました。

### カラートークン（6色・ダークモード非対応）

| トークン | 値 | 用途 | コントラスト比 |
|---|---|---|---|
| `--paper` | `#E9ECEA` | 地色（やや青緑に振ったグレー） | — |
| `--panel` | `#F7F8F7` | 沈めた面（表・伝票・フォーム） | — |
| `--ink` | `#1B2523` | 本文・見出し | 対 paper 13.2:1 |
| `--muted` | `#4F5C5A` | 補足・ラベル | 対 paper 5.8:1 |
| `--line` | `#C3CAC6` | ヘアライン | — |
| `--accent` | `#2E5A50` | CTA・選択状態のみ | 対 paper 6.6:1 / 白文字 7.8:1 |

### 書体

- 本文・見出し：システムフォント（`system-ui` → Hiragino / Yu Gothic / Noto Sans JP）
- 金額・時刻・セクション番号：等幅＋`tabular-nums`

「記録・台帳」を視覚モチーフにしているため、数値はすべて桁が揃います。

### レイアウト

- **全セクション左揃え**（中央揃えは使用していません）
- 左に固定幅レール（PC 148px / SP 44px）を持つ非対称2カラム
- レール境界の**1本のヘアラインが 01 共感パートから 06 予約フォームまで途切れずに縦断**します。「続く」を装飾ではなく構造で表す意図で、FAQ以降では線を切っています
- 角丸は最大4px、影は不使用。全セクションを同じ角丸カードに切る構成にはしていません

---

## 画像素材と動画

### 配置済みのファイル

生成された素材（JPEG 7点・計19MB）を **WebP に変換・リサイズして配置済み**です。

| ファイル | 出力サイズ | 容量 | 用途 |
|---|---|---|---|
| `hero.webp` / `hero-1200.webp` / `hero-800.webp` | 1600×893 / 1200×670 / 800×447 | 82 / 41 / 25 KB | ヒーロー背景（`srcset` で出し分け） |
| `reason-1.webp` | 1200×896 | 66 KB | 完全個室のトレーニングルーム |
| `reason-2.webp` | 1200×896 | 70 KB | トレーナーと利用者の対話 |
| `reason-3.webp` | 1200×896 | 76 KB | 食事記録アプリを見る手元 |
| `trainer-1〜3.webp` | 600×600 | 22 / 30 / 28 KB | トレーナーのポートレート |
| `assets/video/hero-loop.mp4` | — | 1.48 MB | ヒーロー背景動画 |

画像は合計 **440KB**（変換前 19MB）です。変換元の JPEG は `assets/originals/` に残してあります
（配信対象ではありません。リポジトリを軽くしたい場合は削除して構いません）。

### 変換のやり直し

品質やサイズを変えたい場合は `tools/encode-images.mjs` の `JOBS` を編集して再実行します。
ヘッドレス Chrome の `canvas.toBlob('image/webp')` を使うため、cwebp や sharp のインストールは不要です。

```bash
node tools/serve.mjs 8123        # 別ターミナルで起動しておく
node tools/encode-images.mjs
```

出力サイズを変えたときは `index.html` の `width` / `height` 属性も揃えてください（CLS 0 を保つため）。

### ヒーロー背景動画の扱い

仕様書の指示どおり、次の条件で制御しています（`js/ui.js` の `initHeroVideo`）。

| 条件 | 挙動 |
|---|---|
| PC（幅 48em 以上）・通常設定 | `muted` / `playsinline` / `loop` / `autoplay` でループ再生。`poster` に `hero.webp` |
| モバイル（幅 48em 未満） | **動画を読み込まない**（静止画のみ）。通信量とバッテリーに配慮 |
| `prefers-reduced-motion: reduce` | **動画を読み込まない**。再生中に設定が変わった場合は停止して破棄 |
| 自動再生がブラウザに拒否された場合 | 静止画にフォールバック |

HTMLに `<video>` を書かず、条件を満たしたときだけ JavaScript で生成する方式にしています。
`<video>` を書いて CSS で隠す方式では、モバイルでも先読みが走って通信が発生するためです。
読み込みの開始は `window` の `load` 後（`requestIdleCallback`）にしてあり、LCP と TBT には影響しません。

上記の3条件は E2E で自動検証しています（下記「テスト」参照）。

### 生成プロンプト

差し替え用のプロンプト全文（世界観の共通指定・ネガティブ指定・確認ポイント）は
**[`studio-core-lp-assets-prompts.md`](studio-core-lp-assets-prompts.md)** にあります。

**共通**：静けさと余白／自然光／低彩度のグレージュと木材／日本人・30〜40代・過度に筋肉質でない／
筋肉の誇示・汗・黒背景・ネオン・ロゴや文字は避ける。

<details>
<summary>hero.webp のプロンプト</summary>

```
日本の小規模なパーソナルトレーニングジムの完全個室。人物は写っていない。
大きな窓から昼間の柔らかい自然光が差し込み、床には薄い陽だまりができている。
オークの無垢材フローリング、オフホワイトの壁、木製ラックに整然と並んだダンベル。
中央から右側は壁と光の余白が広く取られ、被写体が少ない構図。
落ち着いた生活感のある清潔さ。ミニマルだが冷たくない。
色調はグレージュとウォームウッド。彩度は低め。
建築写真のような自然な遠近感、広角気味、目線の高さから撮影。写実的な写真。
```
（ネガティブ：人物、鏡張りの壁、黒い床、ネオンライト、ハイコントラスト、汗、筋肉の誇示、ロゴ、文字）
</details>

### ヒーローの背景処理

ヒーローは画像（および動画）を背景として敷き、その上にテキストとCTAを重ねています。

- **背景を `transform: scaleX(-1)` で左右反転**しています。元画像はダンベルラックが左にあり、
  左揃えの見出しと重なって読みづらかったためです。反転で被写体を右、余白を左に移し、
  テキストの左揃えは維持しています。
- スクリム（`.hero__media::after`）は**文字の背後だけを覆い、被写体のある右側はほぼ素通し**にしています。
  1200px 未満では本文が右端近くまで伸びるため、均一に近いスクリムへ切り替えます。

| 画面幅 | スクリム | 切り出し位置 |
|---|---|---|
| 〜1199px | `linear-gradient(100deg, .95 → .93 → .90)` | `object-position: 8% 50%` |
| 1200px〜 | `linear-gradient(100deg, .86 → .82 → .55 → .10)` | 中央 |

不透明度は目分量ではなく実測で決めています。ヘッドレスChromeで**テキストを一時的に隠した状態の
スクリーンショットを撮り、文字の行ボックスに当たるピクセルだけを採取**して、文字色との
コントラスト比を算出しました（`.hero__title` は `--ink`、`.hero__lead` と注記は `--muted`）。

| 検証幅 | 見出し | 本文 | 注記（13px） |
|---|---|---|---|
| 412px | 12.5 | 5.16 | 4.90 |
| 800px | 12.6 | 4.91 | 5.51 |
| 1200px | 11.2 | 5.12 | 4.71 |
| 1280px（動画再生中も同値） | 11.3 | 5.12 | 5.16 |
| 1920px | 11.6 | 5.23 | 5.40 |

いずれも最小値で 4.5:1 以上です。**Lighthouse / axe は画像の上に乗る文字のコントラストを判定できない**ため、
この計測を別途行っています（実際、反転前の設定はモバイルで 3.31 まで落ちており、
Lighthouse は 100 のままでした）。写真を差し替えたときは `tools/` の計測手順で再確認してください。

差し替え後は代替テキストの見直しも必要です（`index.html` の `alt` は現在の画像の内容に合わせて記述しています。
ヒーローは背景のため `alt=""`）。

---

## テスト

### 料金計算のユニットテスト（12件）

```bash
node --test test/simulator.test.cjs
```

仕様書の3プラン（33,000 / 59,400 / 52,800円）との一致、期間による逓減、
オプション加算、重複指定、入会金の無料条件、総額計算、異常系の例外などを検証します。

### E2E（ヘッドレスChrome / 依存パッケージなし）

```bash
node tools/serve.mjs 8123      # 別ターミナルで起動しておく
node tools/e2e-check.mjs
```

Chrome DevTools Protocol を直接叩いて、実ブラウザ上で以下を検証します。

| 検証項目 | 内容 |
|---|---|
| 正常系 | 日付選択 → 空き枠取得 → 時間選択 → 入力 → 送信 → 完了表示 → 予約番号発行 |
| 二重送信防止 | 送信中にもう一度 submit しても POST は1回、`form_submit` も1回 |
| フォーカス管理 | STEP遷移ごとに新しい見出しへフォーカスが移る |
| **キーボードのみの予約完了** | Tab / 数字キー / Space / Enter だけで完了画面まで到達できる（フォーカスリングの可視も確認） |
| スクロール計測 | 25 / 50 / 75 / 100% すべての `scroll_depth` が発火する |
| 追従CTA | ヒーロー内では非表示、中間で表示、フォーム到達で非表示＋`inert` |
| エラー分岐 | `network` / `empty` / `conflict` それぞれ別の表示とイベント |
| ヒーロー動画（PC） | 動画が生成され再生される（`muted`/`loop`/`autoplay`/`playsinline`/`poster` を確認） |
| ヒーロー動画（モバイル幅） | 動画要素が生成されず、mp4 のリクエストが 0 件 |
| ヒーロー動画（reduced-motion） | 同上。静止画のみ表示 |

### Lighthouse

```bash
node tools/lighthouse-run.mjs 5                                  # モバイル・5回の中央値
node tools/lighthouse-run.mjs 5 http://127.0.0.1:8123 desktop    # デスクトップ
```

仕様書記載の単発実行も可能です。

```bash
npx lighthouse http://127.0.0.1:8123 --output=json --output-path=./lighthouse-report.json --chrome-flags="--headless"
```

### アクセシビリティ

- Lighthouse Accessibility **100**（axe-core ベース）
- キーボードのみで予約完了まで到達できることを上記E2Eで自動検証
- `outline: none` は未使用。`:focus-visible` で 2px のフォーカスリングを表示
- 本文・補足・CTA すべてコントラスト比 4.5:1 以上
- `prefers-reduced-motion: reduce` でアニメーションとスムーススクロールを停止
- フォームは `label` / `for` / `id` の関連付け、エラーは `aria-describedby` と `aria-invalid`
- 追従CTAは非表示時に `inert`（`aria-hidden` とフォーカス可能要素の同居を避けるため）
- 料金表はモバイルで縦積みに変形しますが、`role` を明示しているため表としての読み上げが保たれます

---

## ディレクトリ構成

```
studio-core-lp/
├── index.html                 # 本体（Critical CSS をインライン展開）
├── config.js                  # GAS_URL・営業時間・デバッグ設定
├── css/
│   ├── critical.css           # インライン化する分のマスター
│   └── main.css               # 非同期で読み込む分
├── js/
│   ├── simulator.js           # 料金計算（純粋関数・DOM非依存）
│   ├── booking.js             # 予約フォーム（状態管理＋通信＋描画）
│   ├── analytics.js           # 計測（dataLayer への push を集約）
│   └── ui.js                  # シミュレーターUI・追従CTA・スムーススクロール
├── data/
│   └── plans.json             # 料金定義（単価・割引率・オプション・入会金）
├── assets/
│   ├── favicon.svg
│   ├── images/                # WebP 9枚（合計440KB。ヒーローは3サイズ）
│   ├── video/
│   │   └── hero-loop.mp4      # ヒーロー背景動画（1.48MB）
│   └── originals/             # 変換元のJPEG（配信対象外）
├── gas/
│   └── Code.gs                # GAS ウェブアプリ（GET/POST・排他・サニタイズ）
├── test/
│   └── simulator.test.cjs     # 料金計算のユニットテスト
├── tools/
│   ├── serve.mjs              # gzip・Range対応の検証用サーバー
│   ├── encode-images.mjs      # JPEG→WebP変換・リサイズ（Chromeのcanvasを使用）
│   ├── e2e-check.mjs          # CDP直叩きのE2E
│   ├── lighthouse-run.mjs     # Lighthouse を複数回実行して中央値を出す
│   └── make-placeholders.mjs  # プレースホルダWebPの生成
├── lighthouse-report.json     # モバイル計測結果
├── lighthouse-report.html     # 同 HTMLレポート
├── lighthouse-desktop.json    # デスクトップ計測結果
└── README.md
```

`css/critical.css` は `index.html` の `<style>` にインライン展開する内容のマスターです。
**片方を編集したらもう片方にも反映してください**（ビルド工程を持たない構成のため、意図的に手動同期にしています）。

---

## 既知の制約

- **変換元の JPEG（`assets/originals/` 計19MB）を残しています**。配信には使いませんが、リポジトリを軽くしたい場合は削除してください（再変換が必要になったときは同じ場所に置き直せば `tools/encode-images.mjs` が動きます）
- **ヒーロー動画は PC のみ**です。モバイルと `prefers-reduced-motion` では静止画のままで、動画は読み込まれません
- 動画は 1.48MB です。仕様書の目安（2MB以下）に収まっていますが、Lighthouse のデスクトップ計測では LCP が 0.3s → 0.5s になります（スコアは 100 のまま）
- **`content-visibility: auto` と スクロール計測の精度**：画面外セクションは実測ベースの推定高さで場所を取るため、ページ最下部まで一度もスクロールしていない状態では文書全体の高さが実際より数%大きく見積もられます。`scroll_depth` の閾値もその分だけ保守的になります（スクロールが進むと実寸に収束します）
- **モバイルの Lighthouse スコアは計測マシンの負荷に強く依存します**。上記の実測値は `benchmarkIndex` 2,900 前後で取得したものです
- **`config.js` の `GAS_URL` は未設定**（モック動作）です。実サーバーに繋ぐ場合は上記セットアップ手順に従ってください
- モックの予約状況は `sessionStorage` に保持しているため、タブを閉じるとリセットされます
- 住所・電話番号・トレーナー・お客様の声はすべて架空です

---

架空の店舗を題材にした制作実績です。
