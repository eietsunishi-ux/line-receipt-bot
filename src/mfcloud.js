/**
 * MFクラウド経費 API連携モジュール
 * OAuth2認証 + 経費明細登録 + レシート画像アップロード
 */

const BASE_URL = "https://expense.moneyforward.com";
const API_BASE = `${BASE_URL}/api/external/v1`;

// ─── OAuth2 認証 ─────────────────────────────────────────

/**
 * OAuth認証URL生成（初回セットアップ時にブラウザで開く）
 */
export function getAuthorizationUrl() {
  const params = new URLSearchParams({
    client_id: process.env.MF_CLIENT_ID,
    redirect_uri: process.env.MF_REDIRECT_URI,
    response_type: "code",
    scope: "office_setting:write user_setting:write transaction:write report:write account:write public_resource:read",
  });
  return `${BASE_URL}/oauth/authorize?${params}`;
}

/**
 * 認証コードからアクセストークンを取得
 */
export async function getAccessToken(authorizationCode) {
  const params = new URLSearchParams({
    client_id: process.env.MF_CLIENT_ID,
    client_secret: process.env.MF_CLIENT_SECRET,
    grant_type: "authorization_code",
    redirect_uri: process.env.MF_REDIRECT_URI,
    code: authorizationCode,
  });
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`トークン取得失敗: ${res.status} ${err}`);
  }
  return res.json(); // { access_token, refresh_token, expires_in, ... }
}

/**
 * リフレッシュトークンでアクセストークンを更新
 */
export async function refreshAccessToken(refreshToken) {
  const params = new URLSearchParams({
    client_id: process.env.MF_CLIENT_ID,
    client_secret: process.env.MF_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`トークン更新失敗: ${res.status} ${err}`);
  }
  return res.json();
}

// ─── トークン管理（簡易版：ファイルベース）───────────────

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = join(__dirname, "..", "data", "token.json");

export function loadToken() {
  if (!existsSync(TOKEN_FILE)) return null;
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, "utf-8"));
  } catch {
    return null;
  }
}

export function saveToken(tokenData) {
  const dir = dirname(TOKEN_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
}

/**
 * 有効なアクセストークンを取得（期限切れなら自動更新）
 */
export async function getValidToken() {
  const token = loadToken();
  if (!token) {
    throw new Error(
      "トークン未設定。先にOAuth認証を完了してください。\n" +
      `認証URL: ${getAuthorizationUrl()}`
    );
  }

  // 期限チェック（期限の5分前に更新）
  if (token.expires_at && Date.now() > token.expires_at - 300_000) {
    console.log("アクセストークンを更新中...");
    const newToken = await refreshAccessToken(token.refresh_token);
    const saved = {
      ...newToken,
      expires_at: Date.now() + newToken.expires_in * 1000,
    };
    saveToken(saved);
    return saved.access_token;
  }

  return token.access_token;
}

// ─── API呼び出し ─────────────────────────────────────────

async function apiRequest(method, path, body = null, accessToken = null) {
  const token = accessToken || (await getValidToken());
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };

  const options = { method, headers };

  if (body && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  } else if (body instanceof FormData) {
    // FormDataの場合はContent-Typeを自動設定させる
    options.body = body;
  }

  const res = await fetch(`${API_BASE}${path}`, options);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`MF API エラー: ${res.status} ${err}`);
  }
  return res.json();
}

/**
 * 事業所情報を取得（office_idの確認用）
 */
export async function getOffice() {
  return apiRequest("GET", "/offices");
}

/**
 * 自分のoffice_member_idを取得
 */
export async function getMe(officeId) {
  return apiRequest("GET", `/offices/${officeId}/me`);
}

/**
 * 経費科目一覧を取得（sub_category_id のマッピング用）
 */
export async function getSubCategories(officeId) {
  return apiRequest("GET", `/offices/${officeId}/ex_sub_categories`);
}

/**
 * 経費明細を登録
 * @param {string} officeId
 * @param {string} memberId
 * @param {Object} data - { date, amount, payee, memo, subCategoryId }
 */
export async function createTransaction(officeId, memberId, data) {
  const body = {
    ex_transaction: {
      date: data.date,
      value: data.amount,
      payee: data.payee || "",
      memo: data.memo || "",
      sub_category_id: data.subCategoryId || null,
    },
  };

  return apiRequest(
    "POST",
    `/offices/${officeId}/office_members/${memberId}/ex_transactions`,
    body
  );
}

/**
 * 経費明細にレシート画像を添付
 * @param {string} officeId
 * @param {string} transactionId - 登録済み経費明細のID
 * @param {Buffer} imageBuffer
 * @param {string} filename
 */
export async function uploadReceipt(officeId, transactionId, imageBuffer, filename = "receipt.jpg") {
  const formData = new FormData();
  const blob = new Blob([imageBuffer], { type: "image/jpeg" });
  formData.append("receipt", blob, filename);

  return apiRequest(
    "POST",
    `/offices/${officeId}/ex_transactions/${transactionId}/receipt`,
    formData
  );
}

// ─── 経費カテゴリ → sub_category_id マッピング ──────────

let categoryCache = null;

/**
 * 経費カテゴリ名からsub_category_idを検索
 */
export async function findSubCategoryId(officeId, categoryName) {
  if (!categoryCache) {
    const result = await getSubCategories(officeId);
    categoryCache = result.ex_sub_categories || [];
  }

  // 部分一致で検索
  const match = categoryCache.find(
    (c) => c.name && c.name.includes(categoryName)
  );
  return match ? match.id : null;
}
