/**
 * OCRモジュール - Claude Vision APIでレシート画像を解析
 */
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * レシート画像からOCRで経費情報を抽出
 * @param {Buffer} imageBuffer - 画像バイナリ
 * @param {string} contentType - MIMEタイプ (image/jpeg等)
 * @returns {Object} { date, amount, payee, category, memo, confidence }
 */
export async function extractReceiptData(imageBuffer, contentType = "image/jpeg") {
  const base64Image = imageBuffer.toString("base64");
  const mediaType = contentType.includes("png") ? "image/png" : "image/jpeg";

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: base64Image },
          },
          {
            type: "text",
            text: `このレシート画像から以下の情報をJSON形式で抽出してください。

必須項目:
- date: 日付 (YYYY-MM-DD形式)
- amount: 合計金額 (数値のみ、税込)
- payee: 支払先（店舗名）

任意項目:
- items: 主な品目 (配列、最大3つ)
- category: 経費カテゴリの推定 ("交通費","会議費","交際費","消耗品費","通信費","雑費" から選択)
- tax: 消費税額 (数値のみ)
- confidence: 読み取り確度 ("high","medium","low")

読み取れない項目はnullにしてください。
JSONのみ出力し、説明文は不要です。`,
          },
        ],
      },
    ],
  });

  const text = response.content[0].text.trim();

  // JSONブロックを抽出（```json ... ``` 形式にも対応）
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) {
    throw new Error("OCR結果のJSON解析に失敗しました");
  }

  const parsed = JSON.parse(jsonMatch[1].trim());

  return {
    date: parsed.date || null,
    amount: parsed.amount ? Number(parsed.amount) : null,
    payee: parsed.payee || null,
    items: parsed.items || [],
    category: parsed.category || "雑費",
    tax: parsed.tax ? Number(parsed.tax) : null,
    confidence: parsed.confidence || "medium",
  };
}
