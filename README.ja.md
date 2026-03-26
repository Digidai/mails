# mails

AIエージェント向けのメールインフラ。プログラムでメールの送受信ができます。

[![npm](https://img.shields.io/npm/v/mails)](https://www.npmjs.com/package/mails)
[![license](https://img.shields.io/npm/l/mails)](https://github.com/chekusu/mails/blob/main/LICENSE)
[![downloads](https://img.shields.io/npm/dm/mails)](https://www.npmjs.com/package/mails)

[English](https://github.com/chekusu/mails/blob/main/README.md) | [中文](https://github.com/chekusu/mails/blob/main/README.zh.md)

> **Agent連携：** [mails-skills](https://github.com/Digidai/mails-skills) を使えば、Claude Code、OpenClaw、その他のAIエージェントにワンコマンドでメール機能を追加できます。

## 仕組み

```
                           送信                                       受信

  Agent                                              外部送信者
    |                                                  |
    |  mails send --to user@example.com                |  agent@mails.dev にメール送信
    |                                                  |
    v                                                  v
+--------+         +----------+              +-------------------+
|  CLI   |-------->|  Resend  |---> SMTP --->| Cloudflare Email  |
|  /SDK  |         |   API    |              |     Routing       |
+--------+         +----------+              +-------------------+
    |                                                  |
    |  または POST /v1/send（ホスティング）               |  email() handler
    |                                                  v
    v                                          +-------------+
+-------------------+                          |   Worker    |
| mails.dev クラウド |                          | (セルフホスト)|
| (月100通無料)      |                          +-------------+
+-------------------+                                  |
                                                       |  保存
                                                       v
                                  +--------------------------------------+
                                  |         ストレージプロバイダー          |
                                  |                                      |
                                  |     D1 (Worker)  /  SQLite          |
                                  +--------------------------------------+
                                                       |
                                              CLI/SDKで問い合わせ
                                                       |
                                                       v
                                                    Agent
                                              mails inbox
                                              mails inbox --query "コード"
                                              mails code --to agent@mails.dev
```

## 特徴

- **メール送信** — Resend経由、添付ファイル対応
- **メール受信** — Cloudflare Email Routing → Worker → D1 経由
- **受信箱検索** — FTS5全文検索（件名、本文、送信者、認証コード）
- **認証コード自動抽出** — メールから4-8桁のコードを自動検出（英/中/日/韓対応）
- **添付ファイル** — CLI `--attach` またはSDKで送信、受信時に大きなファイルはR2に自動保存
- **Webhook通知** — メール受信時にURLへPOST、HMAC-SHA256署名付き
- **メールボックス分離** — `auth_tokens` D1テーブルによるトークン別メールボックスバインディング
- **削除API** — 処理済みメールの削除、添付ファイルとR2オブジェクトのカスケード削除
- **ストレージプロバイダー** — ローカルSQLite（開発用）またはリモートWorker API（本番）
- **ランタイム依存関係ゼロ** — すべてのプロバイダーがネイティブ `fetch()` を使用
- **ホスティングサービス** — `mails claim` で無料 `@mails.dev` メールアドレス取得（月100通無料送信）
- **セルフホスト** — Cloudflareに独自Workerをデプロイ（無料枠で十分）

## インストール

```bash
npm install -g mails
# または
bun install -g mails
# または直接実行
npx mails
```

## クイックスタート

### ホスティングモード (mails.dev)

```bash
mails claim myagent                  # myagent@mails.dev を無料で取得
mails send --to user@example.com --subject "Hello" --body "World"  # 月100通無料
mails inbox                          # 受信箱を確認
mails inbox --query "パスワード"       # メール検索
mails code --to myagent@mails.dev    # 認証コードを待機
```

Resendキー不要 — ホスティングユーザーは月100通無料。無制限送信は自分のキーを設定：`mails config set resend_api_key re_YOUR_KEY`

### セルフホストモード

```bash
cd worker && wrangler deploy         # 独自Workerをデプロイ
mails config set worker_url https://your-worker.example.com
mails config set worker_token YOUR_TOKEN
mails config set mailbox agent@yourdomain.com
mails inbox                          # Worker APIに問い合わせ
```

## CLIリファレンス

### claim

```bash
mails claim <name>                   # name@mails.dev を取得（ユーザーあたり最大10個）
```

### send

```bash
mails send --to <email> --subject <subject> --body <text>
mails send --to <email> --subject <subject> --html "<h1>Hello</h1>"
mails send --from "Name <email>" --to <email> --subject <subject> --body <text>
mails send --to <email> --subject "Report" --body "See attached" --attach report.pdf
```

### inbox

```bash
mails inbox                                  # 最近のメール一覧
mails inbox --mailbox agent@test.com         # メールボックス指定
mails inbox --query "password reset"         # メール検索
mails inbox --query "invoice" --direction inbound --limit 10
mails inbox <id>                             # メール詳細（添付ファイル含む）
```

### code

```bash
mails code --to agent@test.com              # 認証コード待機（デフォルト30秒）
mails code --to agent@test.com --timeout 60 # タイムアウト指定
```

認証コードはstdoutに出力（パイプ用）：`CODE=$(mails code --to agent@test.com)`

### config

```bash
mails config                    # 全設定を表示
mails config set <key> <value>  # 値を設定
mails config get <key>          # 値を取得
```

## SDK

```typescript
import { send, getInbox, searchInbox, getEmail, deleteEmail, waitForCode } from 'mails'

// 送信
const result = await send({
  to: 'user@example.com',
  subject: 'Hello',
  text: 'World',
})

// 添付ファイル付き送信
await send({
  to: 'user@example.com',
  subject: 'Report',
  text: 'See attached',
  attachments: [{ path: './report.pdf' }],
})

// 受信箱一覧
const emails = await getInbox('agent@mails.dev', { limit: 10 })

// 受信箱検索
const results = await searchInbox('agent@mails.dev', {
  query: 'パスワードリセット',
  direction: 'inbound',
})

// メール詳細を取得（添付ファイル含む）
const email = await getEmail('email-id')

// メール削除（カスケード：添付ファイル + R2）
await deleteEmail('email-id')

// 認証コード待機
const code = await waitForCode('agent@mails.dev', { timeout: 30 })
if (code) console.log(code.code) // "123456"
```

## セルフホスト完全ガイド

自分のドメイン + Cloudflare + Resend でメールシステム全体を運用。mails.devに依存しません。

### 前提条件

| 必要なもの | 理由 | 費用 |
|-----------|------|------|
| ドメイン（例：`example.com`） | メールアドレス `agent@example.com` | すでにお持ちのもの |
| Cloudflareアカウント | DNS、Email Routing、Worker、D1 | 無料枠で十分 |
| Resendアカウント | SMTP配信 | 無料100通/日 |

### ステップ1：ドメインをCloudflareに追加

ドメインのDNSがまだCloudflareにない場合、[dash.cloudflare.com](https://dash.cloudflare.com) でドメインを追加し、レジストラのネームサーバーを変更してください。

### ステップ2：Resendで送信ドメインを設定

1. [Resend](https://resend.com) でアカウント登録
2. **Domains** → **Add Domain** → ドメインを入力
3. Resendが提供するDNSレコードをCloudflare DNSに追加：
   - **SPF** — `@` に `TXT` レコード：`v=spf1 include:amazonses.com ~all`
   - **DKIM** — Resendが提供する3つの `CNAME` レコード
   - **DMARC** — `_dmarc` に `TXT` レコード：`v=DMARC1; p=none;`
4. Resendがドメインを検証するまで待機（通常数分、最大48時間）
5. Resend APIキー（`re_...`）をコピー

### ステップ3：Workerをデプロイ

```bash
cd worker
bun install

# D1データベースを作成
wrangler d1 create mails
# → 出力からdatabase_idをコピー

# wrangler.toml を編集 — database_idを貼り付け
# REPLACE_WITH_YOUR_DATABASE_ID を実際のIDに置き換え

# データベーススキーマを初期化
wrangler d1 execute mails --file=schema.sql

# シークレットを設定
wrangler secret put AUTH_TOKEN         # 強力なランダムトークン
wrangler secret put RESEND_API_KEY     # Resendの re_... キー

# デプロイ
wrangler deploy
# → Worker URL: https://mails-worker.<あなたのサブドメイン>.workers.dev
```

### ステップ4：Cloudflare Email Routingを設定（受信）

1. [Cloudflare Dashboard](https://dash.cloudflare.com) → ドメイン → **Email** → **Email Routing**
2. **Enable Email Routing** をクリック（CloudflareがMXレコードを自動追加）
3. **Routing rules** → **Catch-all address** → **Send to a Worker** → デプロイしたWorkerを選択
4. これで `*@example.com` へのすべてのメールがWorkerにルーティングされます

### ステップ5：（オプション）大きな添付ファイル用にR2バケットを作成

```bash
wrangler r2 create mails-attachments
```

R2バインディングは `wrangler.toml` に設定済み。作成後に再デプロイ：

```bash
wrangler deploy
```

### ステップ6：CLIを設定

```bash
mails config set worker_url https://mails-worker.<あなたのサブドメイン>.workers.dev
mails config set worker_token YOUR_AUTH_TOKEN       # ステップ3と同じトークン
mails config set mailbox agent@example.com          # メールアドレス
mails config set default_from agent@example.com     # デフォルト送信者
```

### ステップ7：動作確認

```bash
# Workerが到達可能か確認
curl https://mails-worker.<あなたのサブドメイン>.workers.dev/health

# 受信箱を確認（空のはず）
mails inbox

# テストメールを送信
mails send --to あなたの個人メール@gmail.com --subject "Test" --body "Hello from self-hosted mails"

# 任意のメールクライアントからagent@example.comにメールを送り、確認：
mails inbox
```

### デプロイ後のアーキテクチャ

```
あなたのAgent                            外部送信者
    |                                        |
    |  mails send / mails inbox              |  agent@example.com にメール送信
    v                                        v
+--------+                         +-------------------+
|  CLI   |------ /api/send ------->|  Cloudflare Email |
|  /SDK  |<----- /api/inbox -------|     Routing       |
+--------+                         +-------------------+
    |                                        |
    v                                        v
+--------------------------------------------------+
|           あなたのCloudflare Worker               |
|  /api/send → Resend API → SMTP配信               |
|  /api/inbox, /api/code → D1クエリ (FTS5全文検索)  |
|  email() handler → MIME解析 → D1に保存            |
+--------------------------------------------------+
    |               |
    v               v
+--------+    +------------+
|   D1   |    |     R2     |
| メール  |    |  添付ファイル|
+--------+    +------------+
```

### Workerシークレットリファレンス

| シークレット | 必須 | 説明 |
|------------|------|------|
| `AUTH_TOKEN` | 推奨 | API認証トークン。設定するとすべての `/api/*` エンドポイントに `Authorization: Bearer <token>` が必要 |
| `RESEND_API_KEY` | 送信に必要 | Resend APIキー（`re_...`）。Workerがこれを使ってメールを送信 |
| `WEBHOOK_SECRET` | オプション | HMAC-SHA256署名キー。webhookペイロードの署名に使用（`X-Webhook-Signature` ヘッダー） |

### Worker APIエンドポイント

| エンドポイント | 説明 |
|-------------|------|
| `POST /api/send` | メール送信（`RESEND_API_KEY`が必要） |
| `GET /api/inbox?to=<addr>&limit=20` | メール一覧 |
| `GET /api/inbox?to=<addr>&query=<text>` | メール検索（FTS5全文検索） |
| `GET /api/code?to=<addr>&timeout=30` | 認証コード待機（ロングポーリング） |
| `GET /api/email?id=<id>` | メール詳細（添付ファイル含む） |
| `DELETE /api/email?id=<id>` | メール削除（添付ファイル・R2オブジェクト含む） |
| `GET /api/attachment?id=<id>` | 添付ファイルダウンロード |
| `GET /api/me` | Worker情報と機能 |
| `GET /health` | ヘルスチェック（認証不要） |

### 送信優先順位

CLI/SDKがメールを送信する際、以下の順序で設定を確認：

1. `worker_url` → Worker `/api/send` 経由で送信（セルフホスト推奨）
2. `api_key` → mails.devホスティングサービス経由
3. `resend_api_key` → Resend APIに直接送信

`worker_url` を設定すれば、クライアント側に `resend_api_key` は不要 — ResendキーはWorker側にシークレットとして保存されます。

## ストレージプロバイダー

CLIはストレージプロバイダーを自動検出：
- 設定に `api_key` または `worker_url` がある → リモート（Worker APIに問い合わせ）
- それ以外 → ローカルSQLite（`~/.mails/mails.db`）

## 設定キー

| キー | 設定方法 | 説明 |
|-----|---------|------|
| `mailbox` | `mails claim` または手動 | 受信メールアドレス |
| `api_key` | `mails claim` | mails.devホスティングサービスAPIキー（mk_...） |
| `worker_url` | 手動 | セルフホストWorker URL |
| `worker_token` | 手動 | セルフホストWorker認証トークン |
| `resend_api_key` | 手動 | Resend APIキー（worker_url設定時は不要） |
| `default_from` | `mails claim` または手動 | デフォルト送信者アドレス |
| `storage_provider` | 自動 | `sqlite` または `remote`（自動検出） |

## テスト

```bash
bun test              # ユニットテスト + mock E2E
bun test:coverage     # カバレッジレポート付き
bun test:live         # リアルE2E（.envにResendキーが必要）
```

187テスト、20テストファイル。

## エコシステム

```
┌─────────────────────────────────────────────────────────────┐
│                     mails エコシステム                        │
│                                                              │
│  ┌──────────────┐    ┌──────────────────┐    ┌───────────┐  │
│  │  mails CLI   │    │  mails Worker    │    │   mails   │  │
│  │  & SDK       │───▶│  (Cloudflare)    │◀───│  -skills  │  │
│  │              │    │                  │    │           │  │
│  │  npm i mails │    │  受信 + 送信     │    │  Agent    │  │
│  │              │    │  + 検索 + コード  │    │  Skills   │  │
│  └──────────────┘    └──────────────────┘    └───────────┘  │
│   開発者 / スクリプト      インフラ             AI Agents    │
└─────────────────────────────────────────────────────────────┘
```

| プロジェクト | 概要 | 対象 |
|---|---|---|
| **[mails](https://github.com/Digidai/mails)**（このリポジトリ） | メールサーバー（Worker）+ CLI + SDK | メールインフラをデプロイする開発者 |
| **[mails-skills](https://github.com/Digidai/mails-skills)** | AIエージェント向けスキルファイル | AIエージェント（Claude Code、OpenClaw、Cursor） |

**Agent連携クイックセットアップ：**
```bash
git clone https://github.com/Digidai/mails-skills && cd mails-skills && ./install.sh
```

## コントリビュート

開発環境のセットアップ、プロジェクト構造、PRガイドラインについては [CONTRIBUTING.md](CONTRIBUTING.md) をご覧ください。

## ライセンス

MIT
