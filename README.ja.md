# mails

AIエージェント向けのメールインフラ。プログラムでメールの送受信ができます。

[![npm](https://img.shields.io/npm/v/mails)](https://www.npmjs.com/package/mails)
[![license](https://img.shields.io/npm/l/mails)](https://github.com/chekusu/mails/blob/main/LICENSE)

[English](https://github.com/chekusu/mails/blob/main/README.md) | [中文](https://github.com/chekusu/mails/blob/main/README.zh.md)

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
                                  |  D1 (Worker)  /  SQLite  /  db9.ai  |
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
- **メール受信** — Cloudflare Email Routing Worker経由
- **受信箱検索** — キーワードで件名、本文、送信者、認証コードを検索
- **認証コード自動抽出** — メールから認証コードを自動検出（英/中/日/韓対応）
- **添付ファイル** — CLI `--attach` またはSDKで送信、Workerが自動MIME解析
- **ストレージプロバイダー** — ローカルSQLite、[db9.ai](https://db9.ai)クラウドPostgreSQL、またはリモートWorker API
- **ホスティングサービス** — `mails claim` で無料 `@mails.dev` メールアドレス取得
- **セルフホスト** — 独自Workerデプロイ、オプションのAUTH_TOKEN認証

## インストール

```bash
npm install -g mails
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

```bash
mails claim <name>                           # @mails.dev メールアドレス取得
mails send --to <email> --subject <s> --body <text>
mails send --to <email> --subject <s> --body <text> --attach file.pdf
mails inbox                                  # 最近のメール一覧
mails inbox --query "キーワード"                # 全文検索（関連性順）
mails inbox <id>                             # メール詳細（添付ファイル含む）
mails code --to <addr> --timeout 30          # 認証コード待機
mails config                                 # 設定表示

# 高度なフィルター（mails.dev ホスティング / db9）
mails inbox --has-attachments                # 添付ファイル付きのみ
mails inbox --attachment-type pdf            # 添付ファイルの種類で絞り込み
mails inbox --from github.com               # 送信者で絞り込み
mails inbox --since 2026-03-01 --until 2026-03-20  # 期間指定
mails inbox --header "X-Mailer:sendgrid"    # メールヘッダーで絞り込み

# 自由に組み合わせ可能
mails inbox --from github.com --has-attachments --since 2026-03-13
mails inbox --query "デプロイ" --attachment-type log --direction inbound

# 送信者統計
mails stats senders                          # 送信者の頻度ランキング
```

## SDK

```typescript
import { send, getInbox, searchInbox, waitForCode } from 'mails'

// 送信（添付ファイル対応）
await send({
  to: 'user@example.com',
  subject: 'Report',
  text: 'See attached',
  attachments: [{ path: './report.pdf' }],
})

// 受信箱検索（全文検索、関連性順）
const results = await searchInbox('agent@mails.dev', { query: 'パスワードリセット' })

// 高度なフィルター（mails.dev ホスティング / db9）
const pdfs = await getInbox('agent@mails.dev', {
  has_attachments: true,
  attachment_type: 'pdf',
  since: '2026-03-01',
})

// 認証コード待機
const code = await waitForCode('agent@mails.dev', { timeout: 30 })
```

## Workerセルフホスト

デプロイ後、オプションで認証設定：`wrangler secret put AUTH_TOKEN`

| エンドポイント | 説明 |
|-------------|------|
| `GET /api/inbox?to=<addr>&query=<text>` | メール検索 |
| `GET /api/code?to=<addr>&timeout=30` | 認証コード待機 |
| `GET /api/email?id=<id>` | メール詳細（添付ファイル含む） |

## 設定キー

| キー | 説明 |
|-----|------|
| `mailbox` | 受信メールアドレス |
| `api_key` | mails.devホスティングサービスAPIキー |
| `worker_url` | セルフホストWorker URL |
| `worker_token` | セルフホストWorker認証トークン |
| `resend_api_key` | Resend APIキー |
| `default_from` | デフォルト送信者アドレス |
| `storage_provider` | `sqlite`、`db9`、`remote`（自動検出） |

## テスト

```bash
bun test              # ユニット + E2Eテスト（外部依存なし）
bun test:coverage     # カバレッジレポート付き
bun test:live         # ライブE2Eテスト（.env設定が必要）
bun test:all          # すべてのテスト（ライブE2E含む）
```

ユニットテスト168件 + E2Eテスト71件 = **239件のテスト**、全プロバイダーをカバー。

### プロバイダー別E2Eカバレッジ

|                           | SQLite | db9   | Remote (OSS) | Remote (ホスティング) |
|---------------------------|--------|-------|--------------|---------------------|
| inboundメール保存          | ✅     | ✅    | N/A          | N/A                 |
| メール + 添付ファイル保存  | ✅     | ✅    | N/A          | N/A                 |
| 送信 → 受信（実通信）      | ✅     | —     | ✅           | ✅                  |
| 受信箱一覧                 | ✅     | ✅    | ✅           | ✅                  |
| has_attachmentsフラグ      | ✅     | ✅    | ✅           | ✅                  |
| 方向フィルター             | ✅     | ✅    | ✅           | ✅                  |
| ページネーション           | ✅     | ✅    | ✅           | ✅                  |
| メール詳細                 | ✅     | ✅    | ✅           | ✅                  |
| 添付ファイルメタデータ     | ✅     | ✅    | ✅           | ✅                  |
| 検索                       | ✅     | ✅    | ✅           | ✅                  |
| 添付ファイル内容検索       | ✅     | ✅    | —            | —                   |
| 認証コード                 | ✅     | ✅    | ✅           | ✅                  |
| 添付ファイルダウンロード   | ✅     | ✅    | —            | ✅                  |
| ディスクに保存 (--save)    | ✅     | —     | —            | ✅                  |
| メールボックス分離         | ✅     | ✅    | —            | —                   |
| Outbound記録               | ✅     | —     | N/A          | N/A                 |

## ライセンス

MIT
