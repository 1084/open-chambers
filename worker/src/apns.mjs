// Minimal APNs client for Cloudflare Workers: token-based auth (ES256 JWT), HTTP/2 via fetch.
// Apple docs: https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = s => new TextEncoder().encode(s);

let cached = { jwt: null, at: 0 };

async function importKey(p8) {
  const pem = p8.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

// APNs wants the token refreshed at least hourly and not more than once per 20 minutes.
export async function apnsToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cached.jwt && now - cached.at < 45 * 60) return cached.jwt;
  const key = await importKey(env.APNS_KEY);
  const header = b64url(enc(JSON.stringify({ alg: "ES256", kid: env.APNS_KEY_ID })));
  const claims = b64url(enc(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: now })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc(`${header}.${claims}`));
  // WebCrypto returns raw r||s (64 bytes), which is exactly what JWS ES256 wants.
  cached = { jwt: `${header}.${claims}.${b64url(sig)}`, at: now };
  return cached.jwt;
}

/**
 * Send one notification. Returns { ok, status, reason }.
 * reason "BadDeviceToken" / "Unregistered" (410) means the token should be deleted.
 */
export async function sendPush(env, deviceToken, payload, { collapseId, threadId } = {}) {
  const jwt = await apnsToken(env);
  const body = {
    aps: {
      alert: { title: payload.title, subtitle: payload.subtitle, body: payload.body },
      sound: "default",
      "thread-id": threadId || "openchambers",
      "interruption-level": "active",
      "relevance-score": 0.8,
    },
    ...payload.data,
  };
  const r = await fetch(`${env.APNS_HOST}/3/device/${deviceToken}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${jwt}`,
      "apns-topic": env.APNS_TOPIC,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(Date.now() / 1000) + 6 * 3600),
      ...(collapseId ? { "apns-collapse-id": collapseId.slice(0, 64) } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  let reason = "";
  if (!r.ok) { try { reason = (await r.json()).reason || ""; } catch (e) {} }
  return { ok: r.ok, status: r.status, reason };
}
