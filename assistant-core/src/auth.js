// Google OAuth (OIDC) helpers for the dashboard.
//
// Flow: /auth/login -> Google consent -> /auth/callback?code -> exchange code
// for tokens -> decode id_token -> check email allowlist -> signed session cookie.
//
// The id_token is received directly from Google's token endpoint over TLS
// (server-to-server), so we decode it without a separate JWKS signature check.
//
// Auth is DISABLED until GOOGLE_CLIENT_ID is set, so the dashboard keeps working
// during setup and only locks down once configured.

import { config } from "./config.js";

export function authEnabled() {
  return Boolean(config.googleClientId && config.googleClientSecret && config.googleRedirectUri);
}

export function loginUrl(state) {
  const p = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: config.googleRedirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + p.toString();
}

export async function exchangeCode(code) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: config.googleRedirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`token exchange failed ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const payload = decodeJwt(data.id_token);
  return { email: String(payload.email || "").toLowerCase(), verified: !!payload.email_verified };
}

function decodeJwt(jwt) {
  const part = String(jwt || "").split(".")[1] || "";
  const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return JSON.parse(json || "{}");
}

// Empty allowlist => any Google account is accepted. Otherwise must be listed.
export function emailAllowed(email) {
  if (!config.allowedEmails.length) return true;
  return config.allowedEmails.map((e) => e.toLowerCase()).includes(String(email || "").toLowerCase());
}

export function secureCookies() {
  return config.googleRedirectUri.startsWith("https");
}
