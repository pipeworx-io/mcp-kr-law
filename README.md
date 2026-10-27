# @pipeworx/kr-law

South Korean national statutes: search by title, fetch one article (조문) at
a time with its own effective date, and a statute's revision history. Bring
your own OC (Open API user id) — every call runs on your own registration.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1882+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `kr_law_search(...)` — find statutes by title keyword. Returns each
  match's `mst` (the version id every other tool needs), ministry,
  promulgation/effective dates, and whether it's the current or a superseded
  version.
- `kr_law_article(...)` — fetch ONE article by `mst` + `article_no` (e.g.
  `"5"` or `"4-2"` for 제4조의2). Never the whole law body. Omit
  `article_no` for a paginated table of contents (numbers + titles) instead.
  Returns the article's own text, its paragraphs (항) and items (호), and its
  own effective date — which can differ from the law's own when only that
  article was later amended.
- `kr_law_history(...)` — revision history for a statute: every
  promulgation with its own promulgation date/number and entry-into-force
  date, each a separate historical `mst` you can pass back to
  `kr_law_article`.

## Auth

BYO only, and will stay that way. Every tool requires `_apiKey` — your own OC
from https://open.law.go.kr/LSO/main.do (로그인 → OPEN API → OPEN API 신청).
With no key, every tool refuses before any network call, naming the argument
and where to register.

**Registering an OC requires Korean real-name verification** — a Korean
mobile-carrier identity check or an i-PIN. There is no alien-registration,
passport, or overseas-signup path on the Ministry's own form. Pipeworx has no
Korean-resident staff and cannot complete either method, so there is no
platform key for this pack and none is coming (ruled, fleet #3128,
2026-10-15).

For a quick smoke test only (never use this as a real credential, and never
rely on it being stable), the Ministry's own public demo id `"test"` works
for `kr_law_search` and `kr_law_article`.

**`kr_law_history` needs a service your OC may not have by default.** Even a
real, verified OC must separately enable 법령연혁 (law history) under
*My Applications* on the open.law.go.kr dashboard (OPEN API → 신청내역 →
check the 법령종류 box). An OC without it gets a specific, named error from
this tool rather than a generic failure — follow the steps the error gives.
The public demo id does not have this entitlement at all.

## Data sources

- Ministry of Government Legislation (법제처), National Law Information
  Center Open API — South Korea's official statute database (law, cabinet
  order, and ministerial-ordinance text, with promulgation and
  entry-into-force dates and revision history).

## Known gaps and gotchas

- **Korean-language text only.** No translation is attempted or labelled
  official. The Ministry does not publish an official English statute text
  through this API.
- **`kr_law_history`'s success shape is unproven against a live call** — no
  OC entitled to the history service was available while building this pack.
  The error path (an OC *without* that entitlement) is proven live and is
  what most callers without a premium/full registration will actually see.
  Flag this if it ever drifts from the documented row shape.
- **`article_no` branch numbering**: Korean statutes insert new articles
  between existing ones as "제4조의2" rather than renumbering everything —
  pass that as `"4-2"`. `kr_law_article` with no `article_no` lists every
  valid value for a given `mst`.
- A law's own `시행일자` (effective date) and one specific article's
  `조문시행일자` can differ — an amendment sometimes only moves one article's
  effective date forward. Both are returned, kept separate.
- **www.law.go.kr is itself Cloudflare-fronted and blocks a Cloudflare
  Worker's own egress specifically** (measured live, 2026-10-16: through the
  gateway only 2 of 10 calls succeeded, while a non-CF vantage got 10 of 10).
  Every call is routed through the Pipeworx egress relay, the same
  mechanism as `mcps/oklahoma-code`/`mcps/utah-code` — with a direct-call
  fallback if the relay itself is misconfigured, since direct egress does
  sometimes succeed here. Every tool also retries up to 3 times with
  backoff on a 522/524/503 before giving up; if nothing responds after
  that, the error says plainly that Korea's law service did not respond and
  to try again — never a bare Cloudflare status code or its
  "error code: 5xx" body text.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "kr-law": {
      "url": "https://gateway.pipeworx.io/kr-law/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/kr-law/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1882+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

This pack takes your own API key (`_apiKey`) — we don't front one for it, so there's no curl here that would run without it. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/kr_law_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "kr-law": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-kr-law"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-kr-law
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Kr Law data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
