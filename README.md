# testsprite-watch

Twice-daily watcher for [TestSprite/testsprite-cli](https://github.com/TestSprite/testsprite-cli) issues.

**What it does every run (07:00 & 19:00 UTC):**

1. **Logs** — every comment a maintainer makes on an issue, every approval label
   added/removed (`accepted` / `good first issue` / `help wanted`), every
   assignment / unassignment / claim-rejection, into `log/events.jsonl` plus a
   daily `log/digest-YYYY-MM-DD.md` and the Actions job summary.
2. **Claims** — comments a bare `/assign` on issues that are open for claiming:
   - carries a claimable label (their bot rejects `/assign` on anything else)
   - nobody assigned yet
   - under the 3-claim slot cap
   - no prior failed attempt on that issue (waits for a *fresh* approval signal
     or a 14-day cooldown instead of re-noising the thread)
   - max 2 new claims per run
3. **TTL watch** — warns in the digest when one of your claims is ≥72h old
   without an open PR linking it (their bot releases idle claims at 96h).

**Modes**

- `dryRun: true` in `config.json` → logs `would_claim` entries, posts nothing.
- Go live: set `"dryRun": false`, **or** dispatch the workflow with
  `force_live: true` for a one-off live run.

## Setup (one time)

1. Create a **classic PAT** with scope `public_repo` (fine-grained PATs cannot
   be granted write on a repository you don't own — this token must post
   comments as you on `TestSprite/testsprite-cli`).
2. Repo **Settings → Secrets and variables → Actions → New repository secret**:
   name `TS_PAT`, value the token.
3. Dry run: **Actions → testsprite watch → Run workflow** (leaves `force_live`
   unchecked), read the job summary + `log/`.
4. Live: run the same workflow with `force_live: true`, or flip
   `config.json → "dryRun": false` and commit.

## Layout

```
config.json            target repo, your handle, caps, labels, cooldowns
scripts/watch.mjs      zero-dependency Node ≥20 watcher
state/state.json       last window, attempt history, claim ages, caches (committed each run)
log/events.jsonl       every logged event (append-only, committed each run)
log/digest-*.md        human-readable daily digest
```

## Local run

```sh
GH_TOKEN=$(gh auth token) node scripts/watch.mjs --dry-run --verbose
```
