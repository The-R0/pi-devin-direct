import { randomUUID } from "node:crypto";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { readEnvironmentCredentials, readLocalCredentials, type DevinCredentials } from "./credentials.js";
import { DEFAULT_API_SERVER, OAUTH_CLIENT_ID, REGISTER_USER_URL, SIGN_IN_URL, validateApiServer } from "./endpoints.js";
import { getCachedUserJwt } from "./jwt.js";

const TOKEN_SHAPE = /^[A-Za-z0-9._$~+/=-]{20,4096}$/;

export function parseAuthToken(raw: string): string {
  const value = raw.trim();
  if (TOKEN_SHAPE.test(value)) return value;
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      for (const params of [new URLSearchParams(url.hash.slice(1)), url.searchParams]) {
        for (const key of ["firebase_id_token", "access_token", "id_token", "token"]) {
          const token = params.get(key)?.trim();
          if (token && TOKEN_SHAPE.test(token)) return token;
        }
      }
    } catch { /* Report a fixed message; pasted values are secrets. */ }
  }
  throw new Error("Paste the auth token displayed by the Devin/Windsurf sign-in page, or a callback URL containing it.");
}

export function buildSignInUrl(): string {
  const url = new URL(SIGN_IN_URL);
  url.search = new URLSearchParams({ response_type: "token", client_id: OAUTH_CLIENT_ID,
    redirect_uri: "show-auth-token", state: randomUUID(), prompt: "login" }).toString();
  return url.toString();
}

export async function registerUser(token: string, signal?: AbortSignal): Promise<DevinCredentials> {
  const response = await fetch(REGISTER_USER_URL, {
    method: "POST", redirect: "error",
    headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
    body: JSON.stringify({ firebase_id_token: parseAuthToken(token) }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  // Error bodies can echo the token. Only status leaves this function.
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Devin RegisterUser failed (HTTP ${response.status}). Sign in again and paste a fresh token.`);
  }
  let data: Record<string, unknown>;
  try { data = await response.json() as Record<string, unknown>; }
  catch { throw new Error("Devin RegisterUser returned invalid JSON."); }
  if (!data || typeof data.api_key !== "string" || !data.api_key.trim()) {
    throw new Error("Devin RegisterUser returned no API key.");
  }
  return { apiKey: data.api_key, apiServerUrl: validateApiServer(
    typeof data.api_server_url === "string" && data.api_server_url ? data.api_server_url : DEFAULT_API_SERVER,
  ), source: "browser" };
}

export function toOAuthCredentials(creds: DevinCredentials): OAuthCredentials {
  return { access: creds.apiKey, refresh: "", expires: Number.MAX_SAFE_INTEGER,
    apiServerUrl: creds.apiServerUrl, source: creds.source };
}

export async function loginDevin(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  callbacks.signal?.throwIfAborted();
  const mode = process.env.DEVIN_AUTH_MODE || "auto";
  if (!["auto", "browser", "local"].includes(mode)) throw new Error("DEVIN_AUTH_MODE must be auto, browser, or local.");
  const existing = mode === "browser" ? null : readEnvironmentCredentials() ?? await readLocalCredentials();
  callbacks.signal?.throwIfAborted();
  if (existing) {
    callbacks.onProgress?.(`Validating ${existing.source} credentials...`);
    await getCachedUserJwt(existing.apiKey, existing.apiServerUrl, callbacks.signal);
    return toOAuthCredentials(existing);
  }
  if (mode === "local") throw new Error("No local Devin credentials found. Set DEVIN_AUTH_MODE=browser or auto.");
  callbacks.onAuth({ url: buildSignInUrl(), instructions: "Sign in with your Devin/Cognition account. Copy the auth token shown on the page and paste it in Pi." });
  const pasted = await callbacks.onPrompt({ message: "Paste the Devin auth token (or callback URL):" });
  callbacks.signal?.throwIfAborted();
  callbacks.onProgress?.("Exchanging the sign-in token with Cognition...");
  return toOAuthCredentials(await registerUser(pasted, callbacks.signal));
}
