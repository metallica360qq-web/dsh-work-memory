# dsh-work-memory

Long-term working memory across conversations, for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

It remembers *what you asked for, in which session, and what it produced*, and replays the original text by `session/seq` on demand — including the spans that context compaction discarded.

Since v0.2 it also builds a **topic system out of your own history**: 12 broad areas and 81 fine lines, each with an editable annotation. New conversations are classified by *segment*, and recall walks the label tree level by level instead of matching words.

## What it does now

| Layer | Job | Data |
|---|---|---|
| Capture | One pointer per turn: your request + files written. No summaries. | `hooks.jsonl` |
| Provenance | Separates human requests from agent-generated work (subagent briefs, cron prompts, workflow children) | `origin` field |
| Topics | Two-level labels induced from the material, each with an editable annotation | `topics.json` |
| Segments | A contiguous stretch of work becomes one classification unit | `segments.jsonl` |
| Recall | Hierarchical judgement, or a manually pinned direction; keywords are only a fallback | `systemPrompt.context` |
| Maintenance | Hourly rebuild + classify + segment + prune | scheduled task |

## Why two-pass induction

The first version had 16 hand-written topics and a per-record classifier. Two problems showed up: the keyword classifier and the model labeller agreed only 52% of the time, and one topic always turned into a junk drawer.

v0.2 does inductive coding instead:

1. **Pass 1** — read chronologically, one record at a time. Assign to an existing topic, or open a new one only when nothing fits. When the material is exhausted, the table is done.
2. **Merge** — ask the model which topics are actually the same thing. This run produced 83 fine topics from 585 records and merged only 2: they really were different work lines.
3. **Group** — fold the fine lines into 12 broad areas for navigation.
4. **Pass 2** — re-read everything against the frozen table (no new topics; `NONE` allowed).

Agreement between the two passes: 68.4% at fine level, 83.6% at broad level. 3.8% of records were judged unclassifiable.

## Why classify by segment

A conversation is a continuous Q&A; judging one message alone misfires — “go ahead”, “sounds good” mean nothing out of context.

Measured: 41 of 250 human sessions have ≥2 hooks, and those 41 sessions carry 376/585 of the material (64%) — and before segmentation, 36 of them had hooks scattered across different fine topics. After classifying by segment, long conversations fold back into the line they belong to.

## Recall

| Path | How | Status |
|---|---|---|
| Hierarchical (recommended) | 12 annotated labels → child labels → units | Prototype: 4/6 correct, ~2.6k chars / 4.5s |
| Pinned direction | You pick a label in the panel; recall injects from it | In production |
| Keyword fallback | Literal overlap + threshold | In production, but only 8.8% hit rate over 80 sampled questions |

The hierarchical path is not wired into production yet (`cli/recall-hier.mjs` is the prototype; `lib/units.js` is the segment-level injection unit shared by production and the offline comparison).

## Files

```
<DSH_HOME>/work-memory/
  hooks.jsonl       append-only ledger: pointers + topics + provenance + segment
  topics.json       two-level table: topics (broad) + fine (children) + annotations
  segments.jsonl    segments: id / label / seq span / topic
  pins.json         currently pinned direction (8h TTL by default)
  autopilot.log     scheduled-task log
  .induct/          induction and classification state (resumable)
```

## First run

```bash
node cli/bootstrap.js --dry-run         # plan only
node cli/bootstrap.js --all             # build the ledger from local history (needs a model key)

node cli/induct-topics.mjs --pass 1     # read chronologically, grow the topic table
node cli/induct-topics.mjs --merge
node cli/induct-topics.mjs --group
node cli/apply-induction.mjs            # write topics.json + backfill the ledger

node cli/induct-topics.mjs --assign     # classify against the frozen table
node cli/induct-topics.mjs --assign-apply

node cli/segment-sessions.mjs --build   # segment multi-hook sessions
node cli/segment-sessions.mjs --classify
node cli/segment-sessions.mjs --apply
node cli/segment-sessions.mjs --emit    # write segments.jsonl + tag hooks

node cli/annotate-topics.mjs            # write annotations (editable)
```

Ongoing upkeep runs hourly: `cli/autopilot.cmd` rebuilds recent sessions, then `cli/maintain.js` fills in missing classifications, segments new conversations, and prunes backups.

## Tools

| Tool | Purpose |
|---|---|
| `memory_search(query, limit?)` | Find pointers: title, original request, artifacts, time |
| `memory_open(id, query?, maxChars?)` | Replay the original span by seq |
| `memory_write(title, ask?, artifacts?, supersedes?)` | Add a record manually, or mark supersession |
| `memory_map(topic/session/recent/limit/includeAgents)` | Browse by topic → session → hook |

## Measurements and known issues

- Keyword recall hit rate: 8.8% over 80 sampled questions; 85/120 clean samples had zero hits. Lowering the threshold made it *worse* in a blind A/B.
- Hierarchical recall sometimes returns empty at level 2 and stops; a fallback was added. Level-3 candidates don't yet include sibling fine topics, so adjacent boundaries can miss.
- Induction and classification call a model (GLM by default). `--dry-run` and `--limit` keep the cost bounded.
- The ledger stores pointers only; deleting session logs breaks older hooks (`memory_open` will say it can't find them).

## Layout

```
lib/     host plugin: capture, recall, tools, storage (store/topics/origin/browse/units)
cli/     one-off jobs: bootstrap / induct / segment / annotate / maintain / diagnostics
panel/   companion DSH plugin: the session-view panel (three-level navigation)
docs/    architecture and details
locale/  zh / en strings
```

## License

MIT
