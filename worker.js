/**
 * Top Ten - Cloudflare Worker API proxy.
 *
 * Keeps the Anthropic API key server-side. The browser never sees it.
 *
 * Deploy:
 *   1. Set ALLOWED_ORIGIN below to your GitHub Pages origin.
 *   2. wrangler secret put ANTHROPIC_API_KEY
 *   3. wrangler deploy
 *
 * The key is read from env.ANTHROPIC_API_KEY (a Worker secret).
 * Never hard-code it in this file.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Origins allowed to call this Worker. Comma-separated, exact match, no
// trailing slash. Add a localhost origin here while testing locally.
// e.g. "https://yourname.github.io,http://localhost:8080"
const ALLOWED_ORIGIN = "https://YOUR-GITHUB-USERNAME.github.io";

const MODEL = "claude-opus-5";

// Non-streaming request: 16000 keeps us clear of HTTP timeouts while leaving
// plenty of room for 10 records plus adaptive thinking.
const MAX_TOKENS = 16000;

// How many web searches Claude may run per request. Higher = better coverage,
// slower and more expensive.
const MAX_SEARCHES = 8;

// Claude Opus 5 runs adaptive thinking by default at "high" effort. Drop to
// "medium" or "low" if you want faster, cheaper answers. Set to null to use
// the API default.
const EFFORT = null;

// Server-side refusal fallback: if a safety classifier declines the request,
// the API transparently retries on another model instead of returning nothing.
// Set to false if your account does not have this beta enabled.
const ENABLE_REFUSAL_FALLBACK = true;

// A search-heavy turn can hit the server-side tool loop limit and come back as
// stop_reason "pause_turn". We resume up to this many times.
const MAX_CONTINUATIONS = 4;

const MAX_TOPIC_LENGTH = 200;

const SYSTEM_PROMPT = [
  "You find the ten best-rated videos on a topic: films, TV series,",
  "documentaries and YouTube videos are all eligible.",
  "",
  "Use web search to find real, current critic and audience ratings, and",
  "real current streaming availability. Never invent a rating or a platform.",
  "",
  "Reply with ONLY a JSON array of exactly 10 objects, best first.",
  "No prose before or after it. No markdown code fences.",
  "",
  "Every object has exactly these six keys, and every value is a string:",
  '  "t"  title',
  '  "y"  release year, 4 digits (for an ongoing series, the first year)',
  '  "k"  kind: one of "Film", "Series", "Documentary", "YouTube"',
  '  "w"  where to watch: comma-separated services, or the channel for YouTube',
  '  "s"  the ratings you actually found, with their sources,',
  '       e.g. "IMDb 8.4/10, RT 92%". Use "" if you found none.',
  '  "p"  one sentence, 25 words or fewer, on why it earns its place',
  "",
  "Rank by rating strength first, then by how squarely the video fits the",
  "topic. Prefer titles a viewer can actually watch today.",
].join("\n");

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = allowedOrigins();
    const corsOrigin = allowed.includes(origin) ? origin : null;

    if (request.method === "OPTIONS") {
      return corsOrigin
        ? new Response(null, { status: 204, headers: corsHeaders(corsOrigin) })
        : deny("Origin not allowed", 403, null);
    }

    if (request.method !== "POST") {
      return deny("Use POST.", 405, corsOrigin);
    }

    // A browser always sends Origin on a cross-origin POST. Requiring it here
    // is what keeps this Worker from becoming an open proxy to your API key.
    if (!corsOrigin) {
      return deny("Origin not allowed", 403, null);
    }

    if (!env || !env.ANTHROPIC_API_KEY) {
      return deny("Server is missing ANTHROPIC_API_KEY.", 500, corsOrigin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return deny("Body must be JSON.", 400, corsOrigin);
    }

    const topic = typeof body.topic === "string" ? body.topic.trim() : "";
    if (!topic) {
      return deny("Missing 'topic'.", 400, corsOrigin);
    }
    if (topic.length > MAX_TOPIC_LENGTH) {
      return deny("Topic is too long.", 400, corsOrigin);
    }

    try {
      const result = await askClaude(topic, env.ANTHROPIC_API_KEY);
      return json(result, 200, corsOrigin);
    } catch (err) {
      const message = err && err.message ? err.message : "Upstream error.";
      const status = err && err.status ? err.status : 502;
      return deny(message, status, corsOrigin);
    }
  },
};

// ---------------------------------------------------------------------------
// Anthropic call
// ---------------------------------------------------------------------------

async function askClaude(topic, apiKey) {
  let messages = [
    {
      role: "user",
      content:
        "Topic: " +
        topic +
        "\n\nFind the ten best-rated videos on this topic and return the JSON array.",
    },
  ];

  for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
    const data = await postMessages(messages, apiKey);

    // The server-side search loop hit its iteration cap. Hand the assistant
    // turn straight back and the API resumes where it stopped. Do not append
    // a "continue" message - the trailing tool block is the signal.
    if (data.stop_reason === "pause_turn" && attempt < MAX_CONTINUATIONS) {
      messages = [messages[0], { role: "assistant", content: data.content }];
      continue;
    }

    if (data.stop_reason === "refusal") {
      const detail =
        data.stop_details && data.stop_details.category
          ? " (" + data.stop_details.category + ")"
          : "";
      throw httpError("The model declined this topic" + detail + ".", 422);
    }

    return {
      text: extractText(data.content),
      stop_reason: data.stop_reason || null,
      // The client keeps whatever parsed and says the list was cut short.
      truncated: data.stop_reason === "max_tokens",
    };
  }

  throw httpError("Search did not finish in time. Try a narrower topic.", 504);
}

async function postMessages(messages, apiKey) {
  const payload = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages,
    tools: [
      {
        type: "web_search_20260209",
        name: "web_search",
        max_uses: MAX_SEARCHES,
      },
    ],
  };

  if (EFFORT) {
    payload.output_config = { effort: EFFORT };
  }

  const headers = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };

  if (ENABLE_REFUSAL_FALLBACK) {
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    payload.fallbacks = "default";
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    // Surface the API's own message, never the request we sent.
    let detail = "";
    try {
      const errBody = await res.json();
      if (errBody && errBody.error && errBody.error.message) {
        detail = ": " + errBody.error.message;
      }
    } catch {
      /* non-JSON error body */
    }
    throw httpError("Anthropic API error " + res.status + detail, 502);
  }

  return res.json();
}

// A response that used web search interleaves search-result blocks with text,
// so the answer can arrive split across several text blocks.
function extractText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function allowedOrigins() {
  return ALLOWED_ORIGIN.split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(obj, status, origin) {
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (origin) Object.assign(headers, corsHeaders(origin));
  return new Response(JSON.stringify(obj), { status, headers });
}

function deny(message, status, origin) {
  return json({ error: message }, status, origin);
}

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}
