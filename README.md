# Top Ten

Type any topic, get the ten best-rated videos on it — films, series,
documentaries, YouTube — with the ratings that were actually found and where
each one streams.

No accounts, no cookies, nothing stored. The page holds your topic in memory
for the length of one request and forgets it.

## How it fits together

```
index.html  →  worker.js  →  Anthropic API (Claude + web_search)
(GitHub Pages)  (Cloudflare)     key lives here, never in the browser
```

- **`index.html`** — the whole app. No build step, no dependencies, no
  external requests other than the one to your Worker.
- **`worker.js`** — a Cloudflare Worker that holds the API key and proxies the
  call. It also locks CORS to your origin, so it is not an open relay to your
  key.
- **`test/parser.test.mjs`** — tests for the response parsing. Plain Node, no
  dependencies: `node test/parser.test.mjs`.

## Setup

### 1. Get an Anthropic API key

Sign in at <https://platform.claude.com>, then Settings → API keys → Create
key. Copy it there and then; the console will not show it again.

The API is billed separately from a Claude.ai subscription, so add credit
under Billing or the first call comes back `400 credit balance is too low`.
A key with no credit still authenticates, which makes this easy to misread
as a broken Worker.

### 2. Deploy the Worker

Set your Pages origin in `worker.js`:

```js
const ALLOWED_ORIGIN = "https://YOUR-GITHUB-USERNAME.github.io";
```

Comma-separate to add more, e.g. `"https://you.github.io,http://localhost:8080"`.
Exact match, no trailing slash.

Then deploy and set the key as a secret:

```bash
wrangler secret put ANTHROPIC_API_KEY   # paste the key when prompted
wrangler deploy
```

The key is only ever read from `env.ANTHROPIC_API_KEY`. Never put it in a
file in this repo.

### 3. Point the page at the Worker

In `index.html`:

```js
var API_ENDPOINT = "https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev";
```

### 4. Turn on GitHub Pages

Settings → Pages → Source: *Deploy from a branch* → `main` / `/ (root)` → Save.

## The response contract

Claude is asked for a bare JSON array of ten objects. Keys are short to keep
the response small:

| Key | Meaning |
| --- | --- |
| `t` | title |
| `y` | release year, 4 digits |
| `k` | `Film`, `Series`, `Documentary` or `YouTube` |
| `w` | where to watch — services, or the channel for YouTube |
| `s` | the ratings found, with sources, e.g. `IMDb 8.4/10, RT 92%` |
| `p` | one sentence on why it earns its place |

The parser does not assume it gets that cleanly. It strips markdown fences,
tolerates prose around the array, accepts a wrapper object or newline-
delimited objects, and — the case that matters — recovers every complete
record from a response cut short by `max_tokens`. A record needs a title to
survive; every other field falls back to an empty string. Scanning is
string-aware, so a brace or a quote inside a title cannot throw it off.

When the answer arrives short, the page says so rather than quietly showing
six results as if they were ten.

## Tunables in `worker.js`

| Constant | Default | What it does |
| --- | --- | --- |
| `MODEL` | `claude-opus-5` | |
| `MAX_SEARCHES` | `8` | web searches per request; higher is slower and dearer |
| `EFFORT` | `null` | set `"medium"` or `"low"` for faster, cheaper answers |
| `MAX_TOKENS` | `16000` | room for ten records plus adaptive thinking |
| `MAX_CONTINUATIONS` | `4` | resumes a `pause_turn` when the search loop hits its cap |
| `ENABLE_REFUSAL_FALLBACK` | `true` | retries on another model if a classifier declines |

Streaming availability is region-dependent. To bias it toward one country,
add `user_location` to the `web_search` tool definition.

## Notes

- A search takes a while — Claude runs real web searches before answering.
  The page waits up to three minutes and shows a status line throughout.
- `ENABLE_REFUSAL_FALLBACK` uses a beta header. If your account does not have
  it, set it to `false`.
- Ratings and availability are only as good as what the search turned up.
  Claude is told to leave a rating blank rather than invent one.
