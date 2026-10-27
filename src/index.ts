interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities$shared(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities$shared(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * Korea Law MCP — South Korean national statutes via the Ministry of
 * Government Legislation's (법제처) National Law Information Center Open API
 * (open.law.go.kr).
 *
 * BYOK ONLY, and will stay that way (Bruce ruling, fleet #3128, 2026-10-15).
 * Registering an "OC" (the Open API user id) requires Korean real-name
 * verification — a Korean mobile carrier or an i-PIN — with no path for a
 * non-resident, no alien-registration option, and no overseas-signup form.
 * Pipeworx has no Korean-resident staff and cannot complete either method, so
 * there is no platform key for this pack and none is coming. Every tool
 * requires `_apiKey`: the caller's own OC, requested at
 * https://open.law.go.kr/LSO/main.do (로그인 -> OPEN API -> OPEN API 신청).
 * With no key, every tool throws before any network call, and the message
 * SAYS "requires an API key" (gated-refusal wording convention).
 *
 * The public demo OC `"test"` (documented by the Ministry itself, and used
 * only for smoke-testing / these tool-examples — NEVER a default in code)
 * works for `kr_law_search` and `kr_law_article` (confirmed live,
 * 2026-10-15). It is NOT entitled to the history service — a caller's OC must
 * separately opt that service in from their own open.law.go.kr dashboard
 * (OPEN API -> 신청내역 -> check the 법령종류 box for 법령연혁), which
 * `kr_law_history` surfaces as a specific, actionable upstream error rather
 * than a generic failure.
 *
 * Tools:
 * - kr_law_search:  find statutes by title keyword; current or historical.
 * - kr_law_article: fetch one article (조문) by MST + article number,
 *                   never the whole law body. No article number given ->
 *                   a paginated table of contents (article numbers + titles)
 *                   instead of truncating full text.
 * - kr_law_history: promulgation/effective-date revision history for a
 *                   statute, each entry a separate historical MST.
 *
 * Original-language text only (한글/Korean). No translation is attempted or
 * labelled official — Korea's National Assembly/MOLEG do not publish an
 * official English statute text through this API; an unofficial English
 * translation service (elaw.klri.re.kr) is a separate possible pack, not
 * folded in here.
 *
 * Dates are kept apart per the international-legal pack contract:
 * promulgation date (공포일자), promulgation number (공포번호), effective /
 * entry-into-force date (시행일자) at the law level, and — inside
 * kr_law_article — each article's OWN effective date (조문시행일자), which
 * can differ from the law's own if only that article was later amended.
 * current/historical status (현행연혁코드) is a separate field, never folded
 * into a date.
 *
 * TEST COVERAGE NOTE: kr_law_search and kr_law_article are proven LIVE with
 * the Ministry's own public demo OC "test" (2026-10-15) — see
 * mcps/kr-law/smoke.json and tool-examples.json for the exact calls and
 * payload sizes. kr_law_history's ERROR path is also proven live (the exact
 * "미신청된" HTML the upstream returns for an OC without this service is
 * captured as the test fixture below). kr_law_history's SUCCESS path is
 * UNPROVEN LIVE — no OC entitled to the history service was available to this
 * builder — and is instead unit-tested against a fixture built from the same
 * row-shape convention law.go.kr already uses consistently for every other
 * enumerable result (lawSearch's own `<law>` rows: a flat sibling list of
 * 법령일련번호/공포일자/시행일자/제개정구분명/현행연혁코드). `sliceByKey`
 * below is deliberately schema-name-agnostic for this reason — it keys off
 * the one field every such row is known to carry, rather than a guessed
 * wrapper-element name. Flag this when reviewing, the same class of caveat as
 * apollo's (mcps/apollo/src/index.ts).
 *
 * RETRY (fleet #3128 follow-up, 2026-10-15): www.law.go.kr is itself
 * Cloudflare-fronted and intermittently answers with 522/524/503 — measured
 * live, 1 of 20 real kr_law_search calls through the gateway in one window.
 * `pwFetchWithRetry` below retries those (and thrown network errors) up to 3
 * times with backoff before giving up; see its own doc comment. Covered by 5
 * tests in kr-law.test.ts against mocked Cloudflare-shaped responses — the
 * retry/backoff behaviour itself has no live fixture to prove against (it
 * only fires on an upstream blip, not on demand), but the exhausted-retry
 * message IS proven to never leak the raw "error code: 5xx" body.
 *
 * EGRESS RELAY (fleet #3128, second follow-up, 2026-10-16). The retry above
 * helps but does not fix the root cause: Cloudflare's own edge is blocking
 * (or badly throttling) a Cloudflare WORKER's egress to www.law.go.kr
 * specifically, not the origin being slow. Measured live same day: through
 * the gateway (Cloudflare egress), 2 of 10 kr_law_search calls succeeded;
 * from machine 0 directly, 10 of 10 in ~1s each; through a throwaway
 * Supabase Edge Function on the SAME non-CF runtime the shared egress relay
 * uses, 10 of 10 in well under 1.5s each. Same class of hop as
 * oklahoma-code/utah-code (mcps/oklahoma-code/src/index.ts, fleet #2742) —
 * an IP-reputation block, not a TLS-chain issue, so no PINNED_CA entry is
 * needed, only the host allow-listed in `supabase/functions/egress-proxy`.
 * `relayFrom`/`relaySelfError` below are the identical mechanism oklahoma-code
 * uses: the gateway injects `_proxyUrl`/`_proxyToken` for this slug
 * (workers/gateway/src/index.ts), and `pwFetchWithRetry` routes through the
 * relay when present, falling back to a DIRECT call — within the same
 * attempt, not a wasted retry — if the relay itself reports a configuration
 * error (bad token, host not yet allow-listed) rather than an upstream
 * response. Absent `_proxyUrl`/`_proxyToken` (local dev, or a gateway build
 * predating this change), every call goes direct exactly as before.
 */


const UA = 'pipeworx-mcp-kr-law/1.0 (+https://pipeworx.io)';
const BASE = 'https://www.law.go.kr/DRF';
const OC_HELP = 'https://open.law.go.kr/LSO/main.do (로그인 -> OPEN API -> OPEN API 신청)';

async function pwFetch(url: string | URL, init?: RequestInit, timeoutMs?: number): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'Korea Law (MOLEG Open API)', timeoutMs);
}

// ── Egress relay (same mechanism as mcps/oklahoma-code and mcps/utah-code) ─

/** `_proxyUrl`/`_proxyToken`, injected by the gateway for this slug exactly
 *  as for oklahoma-code/utah-code — see workers/gateway/src/index.ts. Absent
 *  (local dev, or a gateway build that predates this fix) every call falls
 *  back to a direct fetch. */
type Relay = { url: string; token: string } | null;

function relayFrom(args: Record<string, unknown>): Relay {
  const url = (args._proxyUrl as string | undefined)?.trim();
  const token = (args._proxyToken as string | undefined)?.trim();
  return url && token ? { url, token } : null;
}

async function pwFetchViaRelay(url: string | URL, relay: NonNullable<Relay>, timeoutMs?: number): Promise<Response> {
  // The relay forwards the target verbatim and returns the upstream
  // response status/body unchanged. userAgent must be passed explicitly —
  // the relay strips caller headers by design.
  return fetchWithTimeout(
    relay.url,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${relay.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: String(url), userAgent: UA }),
    },
    'Korea Law (MOLEG Open API) via the Pipeworx egress relay',
    timeoutMs,
  );
}

/** The relay synthesizes exactly these `{error}` bodies for a request that
 *  never reached www.law.go.kr at all — a dead bearer token, the host not
 *  yet allow-listed. Every one of those is OUR configuration and must never
 *  be read as "Korea's law service refused the request" (same reasoning as
 *  mcps/oklahoma-code's RELAY_SELF_ERRORS / mcps/utah-code's). */
const RELAY_SELF_ERRORS = new Set(['unauthorized', 'bad_request', 'bad_url', 'host_not_allowed', 'method_not_allowed']);

async function relaySelfError(res: Response, relay: Relay): Promise<string | null> {
  if (!relay || res.ok) return null;
  let body: unknown;
  try {
    body = await res.clone().json();
  } catch {
    return null;
  }
  const code = (body as { error?: unknown } | null)?.error;
  if (typeof code !== 'string' || !RELAY_SELF_ERRORS.has(code)) return null;
  return markInternalOrigin(
    `Pipeworx egress relay refused the request (${code}) — this is our own relay configuration, not law.go.kr. See supabase/functions/egress-proxy.`,
    relay.url,
    500,
  );
}

/**
 * www.law.go.kr is Cloudflare-fronted and intermittently answers a
 * legitimate request with 522/524 ("origin connection timed out" / "a
 * timeout occurred") or 503 instead of its own response — confirmed live,
 * fleet #3128 follow-up, 2026-10-15: of 20 real gateway calls to
 * kr_law_search in one measured window, 1 hit a bare 522 while the rest
 * succeeded in well under a second each. Same shape and same fix as hudoc's
 * `pwFetchWithRetry` (mcps/hudoc/src/index.ts, fleet #3119): a short in-pack
 * retry with backoff gives the origin time to recover before giving up,
 * rather than a single unlucky request surfacing a Cloudflare status code
 * the caller has no way to act on.
 *
 * A genuine network-level failure (DNS, connection reset, our own timeout —
 * `fetchWithTimeout` THROWS rather than returning a Response for these, per
 * its own doc comment) is retried the same way. Each attempt gets a shorter
 * timeout than this pack's other calls (6s, not the 25s default) so that 3
 * attempts plus backoff stay within roughly a 20s total budget even in the
 * worst case of every attempt timing out outright; every live success so far
 * has landed in well under 6s.
 */
const RETRYABLE_STATUSES = new Set([522, 524, 503]);
const RETRY_TIMEOUT_MS = 6_000;

/** One fetch, preferring the relay when configured. If the relay itself is
 *  broken for this request — a self-error JSON body, or the relay call
 *  itself throwing (network failure reaching the Supabase function) — falls
 *  back to a DIRECT call for this same attempt rather than wasting a whole
 *  retry cycle on a hop that was never going to work. This is NOT the
 *  oklahoma-code/utah-code behaviour (those throw the self-error loudly as
 *  our own fault) — kr-law's measured baseline shows direct egress DOES
 *  sometimes succeed (2 of 10 through the gateway, before this fix), so
 *  falling back here can still answer the call instead of refusing outright. */
async function fetchOnce(url: string | URL, relay: Relay): Promise<Response> {
  if (relay) {
    try {
      const res = await pwFetchViaRelay(url, relay, RETRY_TIMEOUT_MS);
      if (!(await relaySelfError(res, relay))) return res;
    } catch {
      // Relay call itself threw — fall through to a direct attempt below.
    }
  }
  return pwFetch(url, undefined, RETRY_TIMEOUT_MS);
}

async function pwFetchWithRetry(url: string | URL, relay: Relay, attempts = 3): Promise<Response> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchOnce(url, relay);
      if (res.ok || !RETRYABLE_STATUSES.has(res.status) || i === attempts - 1) return res;
    } catch (err) {
      // Rethrown VERBATIM on the last attempt — fetchWithTimeout's own error
      // already carries a proper class token (e.g. "upstream_down: ...") at
      // position 0, and wrapping it here would push that token off position
      // 0 and silently misclassify the error (CLASS_TOKENS doc, error-prefix.ts).
      if (i === attempts - 1) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1)));
  }
  // Unreachable: the loop above always returns or throws on its last
  // iteration. Satisfies the compiler, not a real path.
  throw new Error('upstream_throttled: Korea Law retry loop exhausted without a result.');
}

// ── BYOK plumbing ───────────────────────────────────────────────────────

/** Every tool calls this FIRST, before any network access. Throws a message
 *  that SAYS "requires an API key" and names where to get one. Never
 *  substitutes anything — there is no platform key for this pack, by design
 *  (Korean real-name verification blocks Pipeworx from holding one). */
export function requireOc(tool: string, args: Record<string, unknown>): string {
  const key = args._apiKey;
  delete (args as Record<string, unknown>)._apiKey;
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error(
      `Korea Law ${tool} requires an API key. Pass it via _apiKey — your own OC (Open API user id) from ` +
        `${OC_HELP}. Registration requires Korean real-name verification (Korean mobile or i-PIN); ` +
        `Pipeworx never substitutes a platform key for this pack — none exists. For a quick smoke test ` +
        `only, the Ministry's own public demo id "test" works for kr_law_search and kr_law_article.`,
    );
  }
  return key.trim();
}

async function lawGet(path: 'lawSearch.do' | 'lawService.do', oc: string, params: Record<string, string>, relay: Relay): Promise<string> {
  const qs = new URLSearchParams({ OC: oc, type: 'XML', ...params });
  const res = await pwFetchWithRetry(`${BASE}/${path}?${qs.toString()}`, relay);
  const body = await res.text();
  if (!res.ok) {
    // Still a retryable status after pwFetchWithRetry's attempts are spent —
    // Cloudflare's own error page body for these is a bare, unhelpful
    // "error code: 522"/"524"/"503", which summarizeErrorBody would otherwise
    // pass through verbatim as if it were a real upstream explanation.
    if (RETRYABLE_STATUSES.has(res.status)) {
      throw new Error(
        `upstream_throttled: Korea's law service did not respond (HTTP ${res.status} from its Cloudflare front, ` +
          'even after retrying) — try again in a moment.',
      );
    }
    throw new Error(`Korea Law upstream error (HTTP ${res.status}): ${summarizeErrorBody(body)}`);
  }
  // The upstream signals an invalid OC, or a service the caller's OC has not
  // been granted, with an HTTP 200 HTML error page rather than a non-2xx
  // status or an XML error body — so detect it by content, not status.
  if (/<html[\s>]/i.test(body.slice(0, 200))) {
    if (body.includes('미신청된')) {
      throw new Error(
        'Korea Law: this OC has not been granted this specific service ("미신청된 목록/본문에 대한 접근입니다"). ' +
          `Log in at ${OC_HELP.replace(' (로그인 -> OPEN API -> OPEN API 신청)', '')}, open 신청내역 (my applications), ` +
          'and check the box for the service this tool needs (법령연혁 for kr_law_history), then retry.',
      );
    }
    throw new Error(
      'Korea Law: the OC was rejected (upstream returned an HTML page instead of data) — check that _apiKey is a valid, ' +
        `currently-active OC from ${OC_HELP}.`,
    );
  }
  const resultMsg = textOf(body, 'resultMsg');
  const resultCode = textOf(body, 'resultCode');
  if (resultCode && resultCode !== '00' && resultMsg) {
    throw new Error(`Korea Law upstream error (${resultCode}): ${resultMsg}`);
  }
  // lawService.do (target=law/eflaw) reports "no matching law" as plain text
  // in a bare wrapper element, with no resultCode at all.
  if (body.includes('일치하는 법령이 없습니다')) {
    throw new Error(`Korea Law: no law found for MST "${params.MST ?? ''}". Get a valid mst from kr_law_search first.`);
  }
  return body;
}

// ── Regex-based XML helpers (Workers have no DOMParser) ─────────────────

function esc(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// NOTE: \b is unusable here — JS regex \b is ASCII-word-aware only, so a tag
// name ending in a Korean character sits between two "non-word" characters
// (the last Korean letter and the following `>`), which \b does NOT treat as
// a boundary — the whole pattern then silently fails to match every
// Korean-named tag. A lookahead on the allowed follow character does the
// same disambiguating job (and also stops a short tag name like "조문"
// matching the opening of a longer one like "조문단위") without relying on
// \b's ASCII-only word-character table.
const FOLLOW = '(?=[\\s/>])';

/** Whole element (paired or self-closing), by exact local name. */
function extractTag(s: string, tag: string): string | undefined {
  const re = new RegExp(`<${esc(tag)}${FOLLOW}[^>]*\\/>|<${esc(tag)}${FOLLOW}[^>]*>[\\s\\S]*?<\\/${esc(tag)}>`, 'i');
  return re.exec(s)?.[0];
}

/** All top-level occurrences of an element by local name, in document order. */
export function extractAll(s: string, tag: string): string[] {
  const re = new RegExp(`<${esc(tag)}${FOLLOW}[^>]*>[\\s\\S]*?<\\/${esc(tag)}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[0]);
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

/** Direct text content of a tag — unwraps CDATA when present. */
export function textOf(s: string, tag: string): string | undefined {
  const whole = extractTag(s, tag);
  if (whole === undefined) return undefined;
  const inner = whole.replace(/^<[^>]*>/, '').replace(/<\/[^>]*>$/, '');
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(inner);
  const raw = cdata ? cdata[1] : inner;
  const text = decodeEntities(raw);
  return text === '' ? undefined : text;
}

// ── kr_law_search ─────────────────────────────────────────────────────

export async function searchLaws(oc: string, args: Record<string, unknown>) {
  const query = String(args.query ?? '').trim();
  if (!query) throw new Error('Required argument "query" is missing, e.g. "도로교통법" or a romanized/English title fragment.');
  const display = Math.min(100, Math.max(1, Number(args.display ?? 20) || 20));
  const page = Math.max(1, Number(args.page ?? 1) || 1);
  // "current" narrows to the eflaw (현행법령) target; there is no separate
  // historical-only search target, so "historical"/"all" both search the
  // general law target and the caller filters on the returned "status" field.
  const target = args.status === 'current' ? 'eflaw' : 'law';
  const body = await lawGet('lawSearch.do', oc, { target, query, display: String(display), page: String(page) }, relayFrom(args));
  const totalCnt = Number(textOf(body, 'totalCnt') ?? '0');
  const laws = extractAll(body, 'law').map((block) => ({
    law_id: textOf(block, '법령ID'),
    mst: textOf(block, '법령일련번호'),
    name_korean: textOf(block, '법령명한글'),
    abbreviation: textOf(block, '법령약칭명'),
    law_type: textOf(block, '법령구분명'),
    ministry: textOf(block, '소관부처명'),
    status: textOf(block, '현행연혁코드'), // '현행' current | '연혁' historical
    revision_type: textOf(block, '제개정구분명'),
    promulgation_date: textOf(block, '공포일자'),
    promulgation_no: textOf(block, '공포번호'),
    effective_date: textOf(block, '시행일자'),
  }));
  return {
    query,
    total_count: totalCnt,
    page,
    display,
    has_more: page * display < totalCnt,
    results: laws,
    note: 'mst identifies one specific version — pass it to kr_law_article / kr_law_history. "status":"현행" = currently in force, "연혁" = a past, superseded version.',
    source: 'Ministry of Government Legislation (법제처), National Law Information Center Open API',
    data_as_of: new Date().toISOString().slice(0, 10),
  };
}

// ── kr_law_article ───────────────────────────────────────────────────

interface HangItem {
  item_no?: string;
  text?: string;
  sub_items?: { item_no?: string; text?: string }[];
}

export function parseHang(block: string): HangItem[] {
  return extractAll(block, '항').map((hang) => ({
    item_no: textOf(hang, '항번호'),
    text: textOf(hang, '항내용'),
    sub_items: extractAll(hang, '호').map((ho) => ({
      item_no: textOf(ho, '호번호'),
      text: textOf(ho, '호내용'),
    })),
  }));
}

export function renderArticleText(articleTitle: string | undefined, hangs: HangItem[]): string {
  const lines: string[] = [];
  if (articleTitle) lines.push(articleTitle);
  for (const h of hangs) {
    if (h.text) lines.push(h.text);
    for (const sub of h.sub_items ?? []) {
      if (sub.text) lines.push(`  ${sub.text}`);
    }
  }
  return lines.join('\n');
}

export async function getArticle(oc: string, args: Record<string, unknown>) {
  const mst = String(args.mst ?? '').trim();
  if (!mst) throw new Error('Required argument "mst" is missing — get it from kr_law_search\'s "mst" field for the law you want.');
  const body = await lawGet('lawService.do', oc, { target: 'law', MST: mst }, relayFrom(args));

  const lawMeta = {
    law_id: textOf(body, '법령ID'),
    name_korean: textOf(body, '법령명_한글'),
    ministry: textOf(body, '소관부처'),
    promulgation_date: textOf(body, '공포일자'),
    promulgation_no: textOf(body, '공포번호'),
    effective_date: textOf(body, '시행일자'),
    revision_type: textOf(body, '제개정구분'),
  };

  const articleBlocks = extractAll(body, '조문단위').filter((b) => textOf(b, '조문여부') === '조문');
  const articleNoRaw = args.article_no !== undefined ? String(args.article_no).trim() : '';

  if (!articleNoRaw) {
    // No article requested -> table of contents (numbers + titles only),
    // paginated, never the whole law body in one response.
    const display = Math.min(200, Math.max(1, Number(args.display ?? 50) || 50));
    const page = Math.max(1, Number(args.page ?? 1) || 1);
    const toc = articleBlocks.map((b) => {
      const no = textOf(b, '조문번호');
      const branch = textOf(b, '조문가지번호');
      return { article_no: branch ? `${no}-${branch}` : no, title: textOf(b, '조문제목') };
    });
    const start = (page - 1) * display;
    const slice = toc.slice(start, start + display);
    return {
      mst,
      law: lawMeta,
      total_articles: toc.length,
      page,
      display,
      has_more: start + display < toc.length,
      table_of_contents: slice,
      note: 'Pass one of these article_no values to kr_law_article to fetch that article\'s full text.',
      source: 'Ministry of Government Legislation (법제처), National Law Information Center Open API',
      data_as_of: new Date().toISOString().slice(0, 10),
    };
  }

  const [wantNo, wantBranch] = articleNoRaw.split('-').map((s) => s.trim());
  const match = articleBlocks.find((b) => {
    const no = textOf(b, '조문번호');
    const branch = textOf(b, '조문가지번호');
    if (no !== wantNo) return false;
    if (wantBranch) return branch === wantBranch;
    return !branch;
  });

  if (!match) {
    const available = articleBlocks
      .slice(0, 20)
      .map((b) => {
        const no = textOf(b, '조문번호');
        const branch = textOf(b, '조문가지번호');
        return branch ? `${no}-${branch}` : no;
      })
      .filter(Boolean);
    throw new Error(
      `Korea Law: article "${articleNoRaw}" not found in MST ${mst}. First available article_no values: ${available.join(', ')}` +
        `${articleBlocks.length > 20 ? ', ...' : ''}. Call kr_law_article with no article_no for the full table of contents.`,
    );
  }

  const hangs = parseHang(match);
  const title = textOf(match, '조문제목');
  const lead = textOf(match, '조문내용');

  return {
    mst,
    law: lawMeta,
    article: {
      article_no: articleNoRaw,
      title,
      effective_date: textOf(match, '조문시행일자'), // can differ from the law's own effective_date when only this article was amended
      amendment_note: textOf(match, '조문참고자료'), // e.g. "[전문개정 2011.6.8]"
      paragraphs: hangs,
      text: renderArticleText(lead, hangs),
    },
    note: 'text is official Korean (한글) statute text only — no translation is attempted or labelled official.',
    source: 'Ministry of Government Legislation (법제처), National Law Information Center Open API',
    data_as_of: new Date().toISOString().slice(0, 10),
  };
}

// ── kr_law_history ───────────────────────────────────────────────────

/** Slice a body into one chunk per occurrence of `keyTag`, from that
 *  occurrence to just before the next one (or end of string). Used instead of
 *  `extractAll` with a guessed wrapper-element name: this API's history
 *  response schema could not be verified against live data (the public demo
 *  OC "test" is not entitled to the history service — see `lawGet` above), so
 *  rather than bet on one wrapper tag name, every record is found by its own
 *  always-present identifying field, the way every other row shape in this
 *  API (search results, law bodies) already does it. */
export function sliceByKey(body: string, keyTag: string): string[] {
  const re = new RegExp(`<${esc(keyTag)}>`, 'g');
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) starts.push(m.index);
  return starts.map((start, i) => body.slice(start, i + 1 < starts.length ? starts[i + 1] : body.length));
}

export async function getHistory(oc: string, args: Record<string, unknown>) {
  const mst = String(args.mst ?? '').trim();
  if (!mst) throw new Error('Required argument "mst" is missing — get it from kr_law_search\'s "mst" field for the law you want.');
  const body = await lawGet('lawService.do', oc, { target: 'lsHistory', MST: mst }, relayFrom(args));

  const rows = sliceByKey(body, '법령일련번호').map((b) => ({
    mst: textOf(b, '법령일련번호'),
    revision_type: textOf(b, '제개정구분명'),
    promulgation_date: textOf(b, '공포일자'),
    promulgation_no: textOf(b, '공포번호'),
    effective_date: textOf(b, '시행일자'),
    status: textOf(b, '현행연혁코드'),
  }));

  return {
    mst,
    revision_count: rows.length,
    revisions: rows,
    note: 'Each row is a separate historical version with its own mst — pass it to kr_law_article to read that version\'s text. Requires the caller\'s OC to have 법령연혁 (law history) enabled under My Applications at open.law.go.kr; otherwise this call throws a specific upstream permission error.',
    source: 'Ministry of Government Legislation (법제처), National Law Information Center Open API',
    data_as_of: new Date().toISOString().slice(0, 10),
  };
}

// ── Tool definitions ─────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'kr_law_search',
    description:
      'Search South Korean national statutes by title keyword (국가법령정보, Ministry of Government Legislation). Returns each matching law\'s id, mst (version id — pass to kr_law_article/kr_law_history), ministry, promulgation/effective dates, and whether it is the current ("현행") or a superseded ("연혁") version. BYOK: requires your own OC from open.law.go.kr (Korean real-name verification to register); pass it as _apiKey.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Title keyword, Korean or romanized, e.g. "도로교통법" (Road Traffic Act) or "개인정보".' },
        display: { type: 'number', description: 'Results per page, 1-100 (default 20).' },
        page: { type: 'number', description: '1-based page number (default 1).' },
        status: { type: 'string', enum: ['all', 'current', 'historical'], description: 'Narrow to currently-in-force laws only ("current") or search as-is ("all", default). "historical" still returns the general list; filter client-side on the returned "status" field for superseded versions.' },
        _apiKey: { type: 'string', description: 'Your own OC (Open API user id) from https://open.law.go.kr/LSO/main.do. The Ministry\'s public demo id "test" works here for smoke-testing.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'kr_law_article',
    description:
      'Fetch ONE article (조문) of a South Korean statute by mst (from kr_law_search) and article_no (e.g. "5" or "4-2" for 제4조의2). Never returns the whole law body. Omit article_no to get a paginated table of contents (article numbers + titles) instead. Returns the article\'s own text, paragraphs (항) and items (호), its own effective date (which can differ from the law\'s), and law-level metadata (promulgation date, effective date, ministry) kept as separate fields. BYOK: requires your own OC; pass it as _apiKey.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mst: { type: 'string', description: 'Law version id (법령일련번호) from kr_law_search\'s "mst" field.' },
        article_no: { type: 'string', description: 'Article number, e.g. "5", or "4-2" for a branch article (제4조의2). Omit for a table of contents.' },
        display: { type: 'number', description: 'Table-of-contents mode only: entries per page, 1-200 (default 50).' },
        page: { type: 'number', description: 'Table-of-contents mode only: 1-based page number (default 1).' },
        _apiKey: { type: 'string', description: 'Your own OC (Open API user id) from https://open.law.go.kr/LSO/main.do. The Ministry\'s public demo id "test" works here for smoke-testing.' },
      },
      required: ['mst'],
    },
  },
  {
    name: 'kr_law_history',
    description:
      'Revision history for a South Korean statute: every promulgation with its own date, promulgation number, and entry-into-force date, each as a separate historical mst you can pass to kr_law_article. Requires the caller\'s OC to have the 법령연혁 (law history) service separately enabled under My Applications at open.law.go.kr — if it is not, this throws a specific, actionable upstream error rather than a generic failure. BYOK: pass your OC as _apiKey.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mst: { type: 'string', description: 'Law version id (법령일련번호) from kr_law_search\'s "mst" field.' },
        _apiKey: { type: 'string', description: 'Your own OC (Open API user id) from https://open.law.go.kr/LSO/main.do, with 법령연혁 enabled under My Applications.' },
      },
      required: ['mst'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'kr_law_search': {
      const oc = requireOc('kr_law_search', args);
      return searchLaws(oc, args);
    }
    case 'kr_law_article': {
      const oc = requireOc('kr_law_article', args);
      return getArticle(oc, args);
    }
    case 'kr_law_history': {
      const oc = requireOc('kr_law_history', args);
      return getHistory(oc, args);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
