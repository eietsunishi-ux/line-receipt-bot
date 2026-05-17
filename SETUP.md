# LINE Receipt Bot セットアップガイド

レシート写真をLINEで送信 → OCR → MFクラウド経費に自動登録するBotです。

## 前提条件

- Node.js 18以上
- MFクラウド経費（API連携可能なプラン）
- LINEアカウント
- Anthropic APIキー

## 手順

### 1. LINE Bot 作成

1. [LINE Developers](https://developers.line.biz/) にログイン
2. プロバイダーを作成 → 「Messaging API」チャネルを新規作成
3. チャネル設定から以下を取得:
   - **Channel Secret** → `.env` の `LINE_CHANNEL_SECRET`
   - **Channel Access Token**（発行ボタン押下）→ `.env` の `LINE_CHANNEL_ACCESS_TOKEN`

### 2. MFクラウド経費 API設定

1. MFクラウド経費にログイン
2. 個人設定 → 基本設定 → 「API連携（開発者向け）」
3. 新しいアプリケーションを作成:
   - **リダイレクトURI**: `https://your-domain.com/oauth/callback`
4. 以下を取得:
   - **Client ID** → `.env` の `MF_CLIENT_ID`
   - **Client Secret** → `.env` の `MF_CLIENT_SECRET`

### 3. インストール・起動

```bash
cd line-receipt-bot
cp .env.example .env
# .env を編集して各キーを設定

npm install
npm start
```

### 4. サーバーを公開（HTTPS必須）

開発中は ngrok が便利:

```bash
ngrok http 3000
```

表示されたURL（`https://xxxx.ngrok.io`）を使って:

- LINE Developers → Webhook URL に `https://xxxx.ngrok.io/webhook` を設定
- `.env` の `MF_REDIRECT_URI` を `https://xxxx.ngrok.io/oauth/callback` に更新

### 5. MFクラウド経費のOAuth認証

1. ブラウザで `https://your-domain.com/setup` を開く
2. 「認証」リンクをクリック → MFクラウドにログイン → 許可
3. 「連携完了」が表示されればOK

### 6. テスト

LINEでBotを友達追加して、レシートの写真を送信！

## 本番デプロイ

Render / Railway / Fly.io などに無料〜低コストでデプロイできます。

```bash
# Renderの場合
# 1. GitHubにpush
# 2. Render.comで「New Web Service」
# 3. 環境変数を設定
# 4. デプロイ完了後、URLをLINE WebhookとMF Redirect URIに設定
```

## トラブルシューティング

| 症状 | 対処 |
|------|------|
| Bot が反応しない | Webhook URLが正しいか確認。`/health` にアクセスして動作確認 |
| 「トークン未設定」エラー | `/setup` からOAuth認証をやり直す |
| OCR精度が低い | レシート全体が明るく写るように撮影し直す |
| 金額が0になる | レシートの合計欄が見切れていないか確認 |
