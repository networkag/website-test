/**
 * Contact form backend for Cloudflare Workers.
 *
 * Flow: browser form -> Turnstile token -> this Worker -> Resend Email API
 *
 * Required bindings (see wrangler.toml / README.md):
 *   - env.RATE_LIMIT_KV        KV namespace, used for rate limiting + dedup
 *   - env.TURNSTILE_SECRET_KEY secret, from Cloudflare Turnstile dashboard
 *   - env.RESEND_API_KEY       secret, from the Resend dashboard (starts with "re_")
 *   - env.TO_EMAIL              var, where submissions get sent
 *   - env.FROM_EMAIL            var, "onboarding@resend.dev" for testing, or an
 *                                address on your verified domain for production
 *   - env.FROM_NAME             var, optional display name
 *   - env.ALLOWED_ORIGIN        var, exact origin to allow, or "*" for testing
 */

const MAX_LENGTHS = { name: 100, email: 254, message: 5000 };
// Requires: something@something.tld — at least 2 chars after the last dot.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_BODY_BYTES = 20_000; // generous ceiling for a small contact form

// Rate limit thresholds — tune to taste
const PER_MINUTE_LIMIT = 3;
const PER_DAY_LIMIT = 20;
const DUPLICATE_WINDOW_SECONDS = 300; // reject identical resubmits within 5 min

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const corsHeaders = buildCorsHeaders(env, origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "Method not allowed" }, 405, corsHeaders);
    }

    // Basic origin allowlist. Leave ALLOWED_ORIGIN="*" while testing;
    // lock it to your real site's origin before going live.
    if (env.ALLOWED_ORIGIN && env.ALLOWED_ORIGIN !== "*" && origin !== env.ALLOWED_ORIGIN) {
      return jsonResponse({ ok: false, error: "Forbidden origin" }, 403, corsHeaders);
    }

    const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
    if (contentLength > MAX_BODY_BYTES) {
      return jsonResponse({ ok: false, error: "Payload too large" }, 413, corsHeaders);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: "Invalid JSON" }, 400, corsHeaders);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    // --- Honeypot check ---
    // Real users never see/fill this field. If it's filled, silently pretend
    // success so bots don't learn to adapt their behavior.
    if (typeof body.website === "string" && body.website.trim() !== "") {
      return jsonResponse({ ok: true }, 200, corsHeaders);
    }

    const name = sanitize(body.name);
    const email = sanitize(body.email);
    const message = sanitize(body.message);
    const turnstileToken = typeof body.turnstileToken === "string" ? body.turnstileToken : "";

    // --- Required fields ---
    if (!name || !email || !message || !turnstileToken) {
      return jsonResponse({ ok: false, error: "Missing required fields" }, 400, corsHeaders);
    }

    // --- Length limits (never trust the client's maxlength attribute) ---
    if (
      name.length > MAX_LENGTHS.name ||
      email.length > MAX_LENGTHS.email ||
      message.length > MAX_LENGTHS.message
    ) {
      return jsonResponse({ ok: false, error: "Field too long" }, 400, corsHeaders);
    }

    // --- Format + header-injection guard ---
    if (!EMAIL_RE.test(email) || /[\r\n]/.test(email) || /[\r\n]/.test(name)) {
      return jsonResponse({ ok: false, error: "Invalid input" }, 400, corsHeaders);
    }

    // --- Rate limiting (per IP, two windows) ---
    const rl = await checkRateLimit(env, ip);
    if (rl.limited) {
      return jsonResponse({ ok: false, error: rl.reason }, 429, corsHeaders);
    }

    // --- Duplicate / repeated-submission guard ---
    const isDuplicate = await checkDuplicate(env, ip, email, message);
    if (isDuplicate) {
      return jsonResponse({ ok: false, error: "Duplicate submission, please wait a few minutes" }, 429, corsHeaders);
    }

    // --- Turnstile verification (the actual bot check) ---
    const humanVerified = await verifyTurnstile(env.TURNSTILE_SECRET_KEY, turnstileToken, ip);
    if (!humanVerified) {
      return jsonResponse({ ok: false, error: "Verification failed, please try again" }, 403, corsHeaders);
    }

    // --- Send the email ---
    try {
      await sendEmail(env, { name, email, message, ip });
    } catch (err) {
      return jsonResponse({ ok: false, error: "Could not send message, try again later" }, 502, corsHeaders);
    }

    return jsonResponse({ ok: true }, 200, corsHeaders);
  },
};

function buildCorsHeaders(env, origin) {
  const allowed = env.ALLOWED_ORIGIN && env.ALLOWED_ORIGIN !== "*" ? env.ALLOWED_ORIGIN : origin || "*";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function sanitize(value) {
  if (typeof value !== "string") return "";
  // Strip control characters (keep normal whitespace/newlines within the message).
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim();
}

async function checkRateLimit(env, ip) {
  const now = Date.now();
  const minuteWindow = Math.floor(now / 60_000);
  const dayWindow = Math.floor(now / 86_400_000);
  const minuteKey = `rl:m:${ip}:${minuteWindow}`;
  const dayKey = `rl:d:${ip}:${dayWindow}`;

  const [minuteCountStr, dayCountStr] = await Promise.all([
    env.RATE_LIMIT_KV.get(minuteKey),
    env.RATE_LIMIT_KV.get(dayKey),
  ]);

  const minuteCount = parseInt(minuteCountStr || "0", 10);
  const dayCount = parseInt(dayCountStr || "0", 10);

  if (minuteCount >= PER_MINUTE_LIMIT) {
    return { limited: true, reason: "Too many requests, please slow down" };
  }
  if (dayCount >= PER_DAY_LIMIT) {
    return { limited: true, reason: "Daily submission limit reached" };
  }

  await Promise.all([
    env.RATE_LIMIT_KV.put(minuteKey, String(minuteCount + 1), { expirationTtl: 120 }),
    env.RATE_LIMIT_KV.put(dayKey, String(dayCount + 1), { expirationTtl: 90_000 }),
  ]);

  return { limited: false };
}

async function checkDuplicate(env, ip, email, message) {
  const hash = await sha256(`${ip}:${email}:${message}`);
  const key = `dup:${hash}`;
  const existing = await env.RATE_LIMIT_KV.get(key);
  if (existing) return true;
  await env.RATE_LIMIT_KV.put(key, "1", { expirationTtl: DUPLICATE_WINDOW_SECONDS });
  return false;
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hashBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyTurnstile(secret, token, ip) {
  const formData = new FormData();
  formData.append("secret", secret);
  formData.append("response", token);
  if (ip) formData.append("remoteip", ip);

  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: formData,
  });
  const outcome = await res.json();
  return outcome.success === true;
}

async function sendEmail(env, { name, email, message, ip }) {
  const fromName = env.FROM_NAME || "Website Contact Form";
  const payload = {
    from: `${fromName} <${env.FROM_EMAIL}>`,
    to: [env.TO_EMAIL],
    reply_to: [email],
    subject: `New contact form submission from ${name}`,
    text: `Name: ${name}\nEmail: ${email}\nSubmitted from IP: ${ip}\n\nMessage:\n${message}`,
  };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend error ${res.status}: ${text}`);
  }
}
