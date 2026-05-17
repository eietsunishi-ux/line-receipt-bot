/**
 * LINE Receipt Bot - メインサーバー
 * レシート写真をLINEで送信 → OCR → MFクラウド経費に自動登録
 */
import "dotenv/config";
import express from "express";
import crypto from "crypto";
import { extractReceiptData } from "./ocr.js";
import {
  getAuthorizationUrl,
  getAccessToken,
  saveToken,
  getValidToken,
  getOffice,
  getMe,
  createTransaction,
  uploadReceipt,
  findSubCategoryId,
  validateTokenInfo,
} from "./mfcloud.js";

const app = express();
const PORT = process.env.PORT || 3000;

// ─── LINE設定 ────────────────────────────────────────────

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_API = "https://api.line.me/v2/bot";
const LINE_DATA_API = "https://api-data.line.me/v2/bot";

// ─── MFクラウド設定キャッシュ ────────────────────────────

let mfConfig = null;

async function getMfConfig() {
  if (mfConfig) return mfConfig;
  const offices = await getOffice();
  const officeId = offices.offices[0].id;
  const me = await getMe(officeId);
  mfConfig = {
    officeId,
    memberId: me.office_member.id,
  };
  console.log(`MF設定: office=${officeId}, member=${mfConfig.memberId}`);
  return mfConfig;
}

// ─── LINE署名検証 ────────────────────────────────────────

function validateSignature(body, signature) {
  const hash = crypto
    .createHmac("SHA256", LINE_CHANNEL_SECRET)
    .update(body)
    .digest("base64");
  return hash === signature;
}

// ─── LINE返信 ────────────────────────────────────────────

async function replyMessage(replyToken, text) {
  await fetch(`${LINE_API}/message/reply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
}

// ─── LINE画像取得 ─────────────────────────────────────────

async function getImageContent(messageId) {
  const res = await fetch(`${LINE_DATA_API}/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`画像取得失敗: ${res.status}`);
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}

// ─── メイン処理：レシート → OCR → MF経費登録 ─────────────

async function processReceipt(messageId, replyToken) {
  try {
    // 1. LINEから画像を取得
    console.log(`[1/4] 画像取得中... messageId=${messageId}`);
    const { buffer, contentType } = await getImageContent(messageId);

    // 2. Claude Vision APIでOCR
    console.log("[2/4] OCR処理中...");
    const receipt = await extractReceiptData(buffer, contentType);
    console.log("OCR結果:", JSON.stringify(receipt, null, 2));

    if (!receipt.amount) {
      await replyMessage(replyToken, "金額を読み取れませんでした。\nレシート全体が写るように撮り直してください。");
      return;
    }

    // 3. MFクラウド経費に登録
    console.log("[3/4] MFクラウド経費に登録中...");
    const config = await getMfConfig();

    // カテゴリをsub_category_idに変換
    const subCategoryId = receipt.category
      ? await findSubCategoryId(config.officeId, receipt.category)
      : null;

    const transaction = await createTransaction(
      config.officeId,
      config.memberId,
      {
        date: receipt.date || new Date().toISOString().split("T")[0],
        amount: receipt.amount,
        payee: receipt.payee || "",
        memo: receipt.items?.length > 0
          ? `品目: ${receipt.items.join(", ")}`
          : "",
        subCategoryId,
      }
    );

    const txId = transaction.ex_transaction?.id;

    // 4. レシート画像を添付
    if (txId) {
      console.log("[4/4] レシート画像を添付中...");
      try {
        await uploadReceipt(config.officeId, txId, buffer);
      } catch (e) {
        console.warn("レシート画像の添付に失敗（明細は登録済み）:", e.message);
      }
    }

    // 5. 結果を返信
    const lines = [
      "✅ 経費を登録しました！",
      "",
      `📅 日付: ${receipt.date || "今日"}`,
      `💰 金額: ¥${receipt.amount.toLocaleString()}`,
    ];
    if (receipt.payee) lines.push(`🏪 支払先: ${receipt.payee}`);
    if (receipt.category) lines.push(`📂 科目: ${receipt.category}`);
    if (receipt.items?.length > 0) lines.push(`📝 品目: ${receipt.items.join(", ")}`);
    if (receipt.confidence === "low") {
      lines.push("", "⚠️ 読み取り精度が低めです。MFクラウドで内容を確認してください。");
    }

    await replyMessage(replyToken, lines.join("\n"));
    console.log("登録完了！");

  } catch (error) {
    console.error("処理エラー:", error);
    await replyMessage(
      replyToken,
      `❌ 登録に失敗しました。\n\nエラー: ${error.message}\n\nもう一度お試しください。`
    );
  }
}

// ─── Webhook エンドポイント ──────────────────────────────

// rawBodyを保持するためにjsonパース前にバッファ取得
app.use("/webhook", express.raw({ type: "application/json" }));

app.post("/webhook", async (req, res) => {
  // 署名検証
  const signature = req.headers["x-line-signature"];
  if (!validateSignature(req.body, signature)) {
    console.warn("署名検証失敗");
    return res.status(401).send("Invalid signature");
  }

  const body = JSON.parse(req.body);
  res.status(200).send("OK"); // LINEには即レスポンス

  // イベント処理（非同期）
  for (const event of body.events) {
    if (event.type === "message" && event.message.type === "image") {
      // 画像メッセージ → レシート処理
      processReceipt(event.message.id, event.replyToken);
    } else if (event.type === "message" && event.message.type === "text") {
      // テキストメッセージ → ヘルプ
      const text = event.message.text;
      if (text === "ヘルプ" || text === "help") {
        await replyMessage(
          event.replyToken,
          "📸 レシートの写真を送ってください！\n\n" +
          "自動でOCR読み取りして\nMFクラウド経費に登録します。\n\n" +
          "📌 コツ:\n" +
          "・レシート全体が写るように\n" +
          "・なるべく明るい場所で\n" +
          "・シワを伸ばして撮影"
        );
      } else {
        await replyMessage(
          event.replyToken,
          "レシートの写真を送ってください📸\n「ヘルプ」で使い方を表示します。"
        );
      }
    }
  }
});

// ─── OAuth コールバック（初回セットアップ用）─────────────

app.use(express.json());

app.get("/oauth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("認証コードがありません");

  try {
    const tokenData = await getAccessToken(code);
    const saved = {
      ...tokenData,
      expires_at: Date.now() + tokenData.expires_in * 1000,
    };
    saveToken(saved);
    res.send("✅ MFクラウド経費との連携が完了しました！<br>このページは閉じてOKです。");
    console.log("OAuth認証完了。トークンを保存しました。");
  } catch (error) {
    console.error("OAuth エラー:", error);
    res.status(500).send(`認証エラー: ${error.message}`);
  }
});

// ─── 認証URL表示（セットアップ用）────────────────────────

app.get("/setup", (_req, res) => {
  const url = getAuthorizationUrl();
  res.send(
    `<h2>MFクラウド経費 OAuth認証</h2>` +
    `<p><a href="${url}" target="_blank">こちらをクリックして認証</a></p>`
  );
});

// ─── デバッグ（トークン検証 & API接続テスト）────────────

app.get("/debug", async (_req, res) => {
  const results = { timestamp: new Date().toISOString() };

  // 1. トークン検証
  try {
    results.tokenInfo = await validateTokenInfo();
  } catch (e) {
    results.tokenInfo = { error: e.message };
  }

  // 2. offices API テスト
  if (results.tokenInfo?.valid) {
    try {
      const offices = await getOffice();
      results.offices = { success: true, data: offices };
    } catch (e) {
      results.offices = { success: false, error: e.message };
    }
  }

  res.json(results);
});

// ─── ヘルスチェック ──────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── サーバー起動 ────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🚀 LINE Receipt Bot 起動: http://localhost:${PORT}`);
  console.log(`📋 セットアップ: http://localhost:${PORT}/setup`);
  console.log(`💚 ヘルスチェック: http://localhost:${PORT}/health`);
});
