#!/usr/bin/env node
/**
 * testsprite-watch
 *
 * Watches TestSprite/testsprite-cli for maintainer triage activity:
 *   - logs every maintainer comment on an issue
 *   - logs approval events (accepted / good first issue / help wanted)
 *   - logs assignments, unassignments, and bot accept/reject replies
 *   - claims claimable issues by commenting `/assign` as the configured user
 *
 * Runs on a schedule (GitHub Actions, 2x/day) and is idempotent: state is
 * persisted between runs so each window is processed exactly once.
 *
 * Usage:
 *   node scripts/watch.mjs [--dry-run|--live] [--since <ISO8601>] [--verbose]
 *
 *   --dry-run / --live   override config.json ("dryRun": posts nothing)
 *   --since <ISO8601>    override the window start (default: last run)
 *   --verbose            extra progress output
 *
 * Env:
 *   GH_TOKEN / GITHUB_TOKEN   optional, raises rate limits; required for --live
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = join(ROOT, "config.json");
const STATE_PATH = join(ROOT, "state", "state.json");
const LOG_JSONL = join(ROOT, "log", "events.jsonl");
const DIGEST_DIR = join(ROOT, "log");

const BOT_LOGINS = new Set(["testsprite-hob[bot]", "github-actions[bot]", "dependabot[bot]", "coderabbitai[bot]"]);
const REJECT_MARKERS = ["hasn't been accepted", "you're at the", "issue limit"];
const EVENT_KEEP = new Set(["labeled", "unlabeled", "assigned", "unassigned", "closed", "reopened", "locked", "unlocked"]);

// ---------------------------------------------------------------- utilities

function parseArgs(argv) {
  const args = { mode: null, since: null, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--live") args.mode = "live";
    else if (a === "--dry-run") args.mode = "dry";
    else if (a === "--since") args.since = argv[++i];
    else if (a === "--verbose" || a === "-v") args.verbose = true;
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  return args;
}

function loadJSON(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveJSON(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d = new Date()) => new Date(d).toISOString();

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null;

let apiCalls = 0;
async function api(path, { method = "GET", body = undefined, retries = 2 } = {}) {
  const url = path.startsWith("http") ? path : `https://api.github.com${path}`;
  for (let attempt = 0; ; attempt++) {
    apiCalls++;
    let res;
    // network-level retry (timeouts / resets) before we ever see a status
    let netTry = 0;
    for (;;) {
      try {
        res = await fetch(url, {
          method,
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "testsprite-watch",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30000),
        });
        break;
      } catch (netErr) {
        if (++netTry >= 3) throw netErr;
        await sleep(1000 * netTry);
      }
    }

    if (res.status === 403 || res.status === 429) {
      const remaining = Number(res.headers.get("x-ratelimit-remaining") ?? "1");
      const reset = Number(res.headers.get("x-ratelimit-reset") ?? "0");
      const waitSec = Math.max(0, reset - Math.floor(Date.now() / 1000)) + 2;
      if (remaining === 0 || res.status === 429) {
        const wait = res.status === 429 ? 10 : waitSec; // secondary limits reset fast
        if (attempt < retries && wait <= 90) {
          await sleep(wait * 1000);
          continue;
        }
        const text = await res.text();
        throw new Error(`rate limited (${res.status}) on ${path}; retry in ${wait}s: ${text.slice(0, 200)}`);
      }
    }
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`HTTP ${res.status} on ${method} ${path}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }
}

/** Paginate a collection endpoint. stopAt(pageItems, pageNumber) -> true halts. */
async function paginate(path, { perPage = 100, maxPages = 40, stopAt = null } = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const items = await api(`${path}${sep}per_page=${perPage}&page=${page}`);
    if (!Array.isArray(items) || items.length === 0) break;
    out.push(...items);
    if (stopAt && stopAt(items, page)) break;
    if (items.length < perPage) break;
  }
  return out;
}

// ------------------------------------------------------------------- window

function windowBounds(args, cfg, state) {
  const end = new Date();
  let start;
  if (args.since) {
    start = new Date(args.since);
    if (isNaN(start)) { console.error(`--since is not a valid ISO date: ${args.since}`); process.exit(2); }
  } else if (state.lastRun) {
    start = new Date(state.lastRun);
  } else {
    start = new Date(end.getTime() - cfg.initialWindowHours * 3600_000);
  }
  const maxStart = new Date(end.getTime() - cfg.maxWindowDays * 86400_000);
  if (start < maxStart) start = maxStart;
  if (start > end) start = new Date(end.getTime() - 3600_000);
  return { start: iso(start), end: iso(end) };
}

// ------------------------------------------------------- issue / PR kind

async function isPullRequest(repo, number, state) {
  const key = String(number);
  if (state.knownTargetKind[key]) return state.knownTargetKind[key] === "pr";
  const obj = await api(`/repos/${repo}/issues/${number}`);
  const kind = obj.pull_request ? "pr" : "issue";
  state.knownTargetKind[key] = kind;
  return kind === "pr";
}

/** Fallback: fetch when a claimable label was first added to an issue,
 *  used when we don't have the timestamp cached in state. */
async function firstApprovalTime(repo, number, state, claimableLabels) {
  const key = String(number);
  if (state.approvalTimes && state.approvalTimes[key]) return state.approvalTimes[key];
  try {
    const events = await paginate(`/repos/${repo}/issues/${number}/events?per_page=100`);
    const claimable = new Set(claimableLabels);
    // walk oldest→newest, first claimable label wins
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.event === "labeled" && claimable.has(e.label?.name)) {
        state.approvalTimes[key] = e.created_at;
        return e.created_at;
      }
    }
  } catch {
    // fall through → unknown
  }
  return null;
}

/** When `me` was assigned to an issue (cached) — the clock the repo's
 *  claim TTL (24h warn / 48h release) actually runs on. */
async function claimStart(repo, number, state, me) {
  const key = String(number);
  if (state.claimStarts && state.claimStarts[key]) return state.claimStarts[key];
  try {
    const events = await paginate(`/repos/${repo}/issues/${number}/timeline?per_page=100`);
    const mine = events.filter((e) => e.event === "assigned" && e.assignee?.login === me);
    const at = mine.length ? mine[mine.length - 1].created_at : null;
    if (at) {
      if (!state.claimStarts) state.claimStarts = {};
      state.claimStarts[key] = at;
      return at;
    }
  } catch {
    // fall through → unknown
  }
  return null;
}

// ------------------------------------------------------------ maintainers

const maintainerCache = new Map(); // login -> true/false/null(unknown)

async function isMaintainer(login, state, cfg, association = null) {
  if (!login || BOT_LOGINS.has(login) || login.endsWith("[bot]")) return false;
  if (cfg.maintainers.includes(login)) return true;
  if (maintainerCache.has(login)) return maintainerCache.get(login);

  let verdict = false;
  // 1. cheap signal: comment author_association for this specific event
  if (["OWNER", "MEMBER", "COLLABORATOR"].includes(association)) verdict = true;
  // 2. remembered from a previous run
  else if (state.maintainers[login] !== undefined) verdict = state.maintainers[login];
  else {
    // 3. authoritative: repository permission (same check the repo's own bot
    //    uses). Requires push access to succeed; without it we fall back to
    //    the association result recorded in step 1.
    try {
      const d = await api(`/repos/${cfg.repo}/collaborators/${login}/permission`);
      verdict = ["admin", "maintain", "write"].includes(d.permission);
    } catch {
      verdict = false;
    }
    state.maintainers[login] = verdict;
  }
  maintainerCache.set(login, verdict);
  return verdict;
}

// ------------------------------------------------------------------- logging

function logEvent(entry) {
  mkdirSync(DIGEST_DIR, { recursive: true });
  appendFileSync(LOG_JSONL, JSON.stringify({ ts: iso(), ...entry }) + "\n");
}

function excerpt(text, n = 200) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > n ? clean.slice(0, n) + "…" : clean;
}

// --------------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadJSON(CONFIG_PATH, null);
  if (!cfg) { console.error(`missing config at ${CONFIG_PATH}`); process.exit(2); }
  const dryRun = args.mode === "live" ? false : args.mode === "dry" ? true : !!cfg.dryRun;
  if (!dryRun && !TOKEN) {
    console.error("LIVE mode requires GH_TOKEN (or GITHUB_TOKEN) in the environment — refusing to run unauthenticated.");
    process.exit(2);
  }
  if (!TOKEN) console.warn("warning: no token — unauthenticated rate limit is 60 req/h; run may fail on busy windows");
  const state = loadJSON(STATE_PATH, {
    lastRun: null,
    attempts: {},
    myClaims: {},
    maintainers: {},
    knownTargetKind: {},
    approvalTimes: {},
  });
  if (!state.knownTargetKind) state.knownTargetKind = {};

  const win = windowBounds(args, cfg, state);
  const v = (...m) => args.verbose && console.log(...m);

  console.log(`testsprite-watch | repo=${cfg.repo} me=${cfg.me}`);
  console.log(`mode: ${dryRun ? "DRY-RUN (no comments will be posted)" : "LIVE"}`);
  console.log(`window: ${win.start} → ${win.end}`);

  // ---- 1. claim pool: open, claimable-labelled, nobody assigned -----------
  const pool = new Map();
  for (const label of cfg.claimableLabels) {
    const items = await api(`/repos/${cfg.repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`);
    for (const i of items) {
      if (i.pull_request) continue;
      if (i.locked) continue;
      if ((i.assignees || []).length > 0) continue; // already taken (skip-prone)
      pool.set(i.number, i);
    }
    v(`  pool label "${label}": ${items.length} raw`);
  }
  const candidates = [...pool.values()];

  // ---- 2. my current claims (for the 3-slot cap) --------------------------
  const mine = (await api(`/repos/${cfg.repo}/issues?state=open&assignee=${cfg.me}&per_page=100`))
    .filter((i) => !i.pull_request);
  let capCount = mine.length;

  // ---- 3. window: issue comments ------------------------------------------
  const comments = await paginate(`/repos/${cfg.repo}/issues/comments?since=${encodeURIComponent(win.start)}`, {
    stopAt: (items) => new Date(items[items.length - 1].created_at) < new Date(win.start),
  });
  v(`  comments in window: ${comments.length}`);

  // ---- 4. window: issue events --------------------------------------------
  const events = await paginate(`/repos/${cfg.repo}/issues/events`, {
    maxPages: 30,
    stopAt: (items) => new Date(items[items.length - 1].created_at) < new Date(win.start),
  });
  v(`  events fetched: ${events.length}`);

  // ---- 5. classify window comments ----------------------------------------
  const logEntries = [];
  const maintainerCommentIssues = new Map(); // issue -> {login, at}
  const newApprovals = [];                  // issues approved inside this window
  let commentTargets = new Map(); // number -> {isPr}

  for (const c of comments) {
    const num = Number(c.issue_url.split("/").pop());
    if (!commentTargets.has(num)) commentTargets.set(num, { isPr: null });
  }
  // resolve issue-vs-PR for comment targets (cached in state)
  let lookups = 0;
  for (const [num, info] of commentTargets) {
    if (lookups++ > 60) break;
    try {
      info.isPr = await isPullRequest(cfg.repo, num, state);
    } catch {
      info.isPr = null; // leave unresolved — those comments are skipped this run
    }
  }

  for (const c of comments) {
    const num = Number(c.issue_url.split("/").pop());
    const target = commentTargets.get(num);
    if (!target || target.isPr === null) continue; // lookup budget exhausted
    if (target.isPr) continue;
    const login = c.user.login;
    const url = `https://github.com/${cfg.repo}/issues/${num}#issuecomment-${c.id}`;
    const body = c.body || "";

    // bot replies about OUR claims (accept / reject)
    if (login === "testsprite-hob[bot]") {
      if (body.includes(`@${cfg.me}`)) {
        const rejected = REJECT_MARKERS.some((m) => body.toLowerCase().includes(m));
        const confirmed = body.startsWith("Assigned to @");
        if (rejected) {
          const a = state.attempts[num] || {};
          state.attempts[num] = { ...a, last: c.created_at, count: (a.count || 0) + 1, result: "rejected" };
          logEntries.push({ type: "claim_rejected", issue: num, actor: login, detail: excerpt(body), url });
        } else if (confirmed) {
          state.myClaims[num] = { ...(state.myClaims[num] || {}), claimedAt: c.created_at };
          const a = state.attempts[num] || {};
          state.attempts[num] = { ...a, result: "confirmed" };
          logEntries.push({ type: "claim_confirmed", issue: num, actor: login, detail: excerpt(body), url });
        }
      }
      continue;
    }
    if (login === cfg.me) {
      if (/^\s*\/assign\b/m.test(body)) {
        logEntries.push({ type: "my_claim_comment", issue: num, actor: login, detail: excerpt(body), url });
      } else {
        logEntries.push({ type: "my_comment", issue: num, actor: login, detail: excerpt(body), url });
      }
      continue;
    }

    const maint = await isMaintainer(login, state, cfg, c.author_association);
    if (maint) {
      maintainerCommentIssues.set(num, { login, at: c.created_at, url, excerpt: excerpt(body) });
      logEntries.push({ type: "maintainer_comment", issue: num, actor: login, detail: excerpt(body), url });
    }
  }

  // ---- 6. classify window events ------------------------------------------
  const issueEvents = events.filter((e) => e.issue && !e.issue.pull_request);
  for (const e of issueEvents) {
    if (!EVENT_KEEP.has(e.event)) continue;
    const num = e.issue.number;
    const url = `https://github.com/${cfg.repo}/issues/${num}`;
    const label = e.label?.name;

    if (e.event === "labeled" && cfg.claimableLabels.includes(label)) {
      // first claimable label starts the 48-hour reservation clock
      if (!state.approvalTimes) state.approvalTimes = {};
      if (!state.approvalTimes[String(num)]) state.approvalTimes[String(num)] = e.created_at;
      newApprovals.push({ issue: num, label, at: e.created_at });
      // a fresh approval clears a previous failed attempt for this issue
      state.attempts[num] = { ...(state.attempts[num] || {}), lastApproval: e.created_at };
      logEntries.push({ type: "approval_added", issue: num, actor: e.actor.login, label, url });
    } else if (e.event === "unlabeled" && cfg.claimableLabels.includes(label)) {
      logEntries.push({ type: "approval_removed", issue: num, actor: e.actor.login, label, url });
    } else if (e.event === "assigned" && e.assignee) {
      logEntries.push({ type: "assigned", issue: num, actor: e.actor.login, assignee: e.assignee.login, url });
      if (e.assignee.login === cfg.me) {
        state.myClaims[num] = { ...(state.myClaims[num] || {}), claimedAt: e.created_at };
      }
    } else if (e.event === "unassigned" && e.assignee) {
      logEntries.push({ type: "unassigned", issue: num, actor: e.actor.login, assignee: e.assignee.login, url });
      if (e.assignee.login === cfg.me) delete state.myClaims[num];
    } else if (e.event === "closed") {
      logEntries.push({ type: "closed", issue: num, actor: e.actor.login, url });
      delete state.myClaims[num];
    } else if (e.event === "reopened") {
      logEntries.push({ type: "reopened", issue: num, actor: e.actor.login, url });
    } else if ((e.event === "labeled" || e.event === "unlabeled") && cfg.watchLabels.includes(label)) {
      logEntries.push({ type: e.event === "labeled" ? "watch_label_added" : "watch_label_removed", issue: num, actor: e.actor.login, label, url });
    }
  }

  for (const entry of logEntries) logEvent(entry);

  // ---- 7. claim decisions --------------------------------------------------
  const now = Date.now();
  const cooldownMs = cfg.attemptCooldownDays * 86400_000;
  const approvalAt = new Map(newApprovals.map((a) => [a.issue, a.at]));

  const freshPool = candidates.filter((c) => {
    const attempt = state.attempts[c.number];
    if (!attempt) return true;
    const attemptAt = new Date(attempt.last || 0).getTime();
    const freshApproval = approvalAt.get(c.number) && new Date(approvalAt.get(c.number)).getTime() > attemptAt;
    if (freshApproval) return true;                     // maintainer (re-)approved → retry allowed
    if (attempt.result === "rejected") return false;    // public reject → stay out until new signal
    if (attempt.result === "confirmed") return false;   // we already hold it (or held it)
    if (now - attemptAt < cooldownMs) return false;     // recent try, no signal
    return true;                                        // cooldown elapsed
  });

  // 48-hour reservation: newly accepted issues are reserved for the issue author
  const reservedPool = [];
  for (const c of freshPool) {
    const apprTime = await firstApprovalTime(cfg.repo, c.number, state, cfg.claimableLabels);
    let reserved = false;
    if (apprTime) {
      const hoursSince = (now - new Date(apprTime).getTime()) / 3600_000;
      if (hoursSince < cfg.reservationHours && c.user.login !== cfg.me) {
        reserved = true;
      }
    }
    if (reserved) {
      logEvent({ type: "reservation_skip", issue: c.number, detail: `reserved for @${c.user.login} (${Math.round(hoursSince)}h since approval)`, url: `https://github.com/${cfg.repo}/issues/${c.number}` });
    } else {
      reservedPool.push(c);
    }
  }

  // priority: issues a maintainer just commented on > newest approval > oldest issue
  freshPool.sort((a, b) => {
    const ma = maintainerCommentIssues.has(a.number) ? 1 : 0;
    const mb = maintainerCommentIssues.has(b.number) ? 1 : 0;
    if (ma !== mb) return mb - ma;
    const aa = approvalAt.get(a.number) || "";
    const ab = approvalAt.get(b.number) || "";
    if (aa !== ab) return ab < aa ? -1 : 1;
    return a.number - b.number;
  });

  const claims = [];
  for (const c of reservedPool) {
    if (capCount >= cfg.slotCap) break;
    if (claims.length >= cfg.maxClaimsPerRun) break;
    claims.push(c);
  }

  const claimResults = [];
  for (const c of claims) {
    const url = `https://github.com/${cfg.repo}/issues/${c.number}`;
    if (dryRun) {
      claimResults.push({ issue: c.number, title: c.title, result: "would_claim", url });
      logEvent({ type: "would_claim", issue: c.number, detail: excerpt(c.title, 120), url });
      continue;
    }
    try {
      await api(`/repos/${cfg.repo}/issues/${c.number}/comments`, { method: "POST", body: { body: cfg.commentBody } });
      const ts = iso();
      state.attempts[c.number] = { ...(state.attempts[c.number] || {}), first: (state.attempts[c.number] || {}).first || ts, last: ts, count: ((state.attempts[c.number] || {}).count || 0) + 1, result: "posted" };
      saveJSON(STATE_PATH, state); // persist immediately — a posted comment is not repeatable
      capCount++;
      claimResults.push({ issue: c.number, title: c.title, result: "posted", url });
      logEvent({ type: "claim_posted", issue: c.number, detail: excerpt(c.title, 120), url });
      await sleep(500); // be polite
    } catch (err) {
      claimResults.push({ issue: c.number, title: c.title, result: `error: ${err.message}`, url });
      logEvent({ type: "claim_error", issue: c.number, detail: String(err.message), url });
    }
  }

  // ---- 8. TTL watch: repo policy is 24h warning / 48h release --------------
  // Claims opened before CLAIM_TTL_SINCE (2026-09-24) are grandfathered and
  // never expire, so they never produce a warning either.
  const ttlWarnings = [];
  const ttlSinceMs = new Date(cfg.ttlSince).getTime();
  const knownClaims = [];
  for (const i of mine) {
    if (!state.myClaims[i.number]?.claimedAt) {
      state.myClaims[i.number] = { ...(state.myClaims[i.number] || {}), firstSeen: iso() };
    }
    const at = state.myClaims[i.number].claimedAt || (await claimStart(cfg.repo, i.number, state, cfg.me));
    if (!at) continue;
    state.myClaims[i.number].claimedAt = at;
    knownClaims.push({ i, at, ageH: (now - new Date(at).getTime()) / 3600_000 });
  }
  if (knownClaims.length > 0) {
    const openPrs = await paginate(`/repos/${cfg.repo}/pulls?state=open`, { maxPages: 5 });
    const myPrs = openPrs.filter((p) => p.user.login === cfg.me && p.body);
    for (const { i, at, ageH } of knownClaims) {
      const grandfathered = new Date(at).getTime() < ttlSinceMs;
      const linked = myPrs.some((p) => {
        const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|part\s+of|refs?|references?|related\s+to)\s*:?\s+#(\d+)/gi;
        return [...p.body.matchAll(re)].some((m) => Number(m[1]) === i.number);
      });
      ttlWarnings.push({
        issue: i.number,
        title: i.title,
        ageH: Math.round(ageH),
        linked,
        grandfathered,
        due: !grandfathered && !linked && ageH >= cfg.ttlReleaseHours,
        url: `https://github.com/${cfg.repo}/issues/${i.number}`,
      });
    }
  }

  // ---- 9. summary ----------------------------------------------------------
  const claimableNow = candidates.length;
  const triagePipeline = await api(
    `/search/issues?q=${encodeURIComponent(`repo:${cfg.repo} is:issue is:open label:"${cfg.watchLabels[0]}"`)}&per_page=1`
  ).then((r) => r.total_count ?? 0).catch(() => -1);

  const summary = [];
  summary.push(`## testsprite-watch — ${win.end}`);
  summary.push(`- mode: **${dryRun ? "dry-run" : "live"}** · window ${win.start} → ${win.end} · ${apiCalls} API calls`);
  summary.push(`- maintainer comments: **${maintainerCommentIssues.size}** · approvals: **${newApprovals.length}** · log entries: **${logEntries.length}**`);
  for (const [num, info] of maintainerCommentIssues) {
    summary.push(`  - @${info.login} on [#${num}](${info.url}): "${info.excerpt}"`);
  }
  for (const a of newApprovals) {
    summary.push(`  - **${a.label}** added to [#${a.issue}](https://github.com/${cfg.repo}/issues/${a.issue}) by ${logEntries.find((e) => e.type === "approval_added" && e.issue === a.issue)?.actor ?? "?"} (${a.at})`);
  }
  if (claimResults.length === 0) summary.push(`- claims: none (pool ${claimableNow}, cap ${capCount}/${cfg.slotCap})`);
  for (const r of claimResults) summary.push(`- claim [#${r.issue}](${r.url}): **${r.result}** — ${r.title}`);
  for (const w of ttlWarnings) {
    const status = w.grandfathered
      ? "🔒 grandfathered — assigned before 2026-09-24, TTL will not release it"
      : w.linked
        ? "✅ held by a linked PR"
        : w.due
          ? `⛔ due for release — ${w.ageH}h old, no linked PR (${cfg.ttlReleaseHours}h TTL)`
          : `⏳ ${w.ageH}h old — releases at ${cfg.ttlReleaseHours}h without a linked PR`;
    summary.push(`- claim [#${w.issue}](${w.url}): ${status}`);
  }
  summary.push(`- claimable pool now: ${claimableNow} · needs-triage pipeline: ${triagePipeline}`);

  const text = summary.join("\n");
  console.log("\n" + text);

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
  }

  // ---- 10. persist ----------------------------------------------------------
  state.lastRun = win.end;
  saveJSON(STATE_PATH, state);
  mkdirSync(DIGEST_DIR, { recursive: true });
  const digestPath = join(DIGEST_DIR, `digest-${win.end.slice(0, 10)}.md`);
  appendFileSync(digestPath, "\n" + text + "\n");
}

main().catch((err) => {
  console.error("watch failed:", err);
  process.exit(1);
});
