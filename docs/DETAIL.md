# Work memory

A conversation-level index of the work you have already done with DSH. Each entry is a **pointer** — session id, sequence range, one-line title, artifact paths — not a summary. When a long conversation gets compacted, the original events stay on disk; this plugin takes you back to them verbatim.

## What you get

- **Three tools.** `memory_search` finds past work by description, file name, or keyword. `memory_open` replays the exact span from the session log, including text that compaction hid. `memory_write` records a decision manually.
- **Automatic capture.** Every turn that reads like real work (a substantial request, or files written) is indexed at the end of the turn, with its topic guessed from keywords.
- **Context injection.** Before each step it searches what you just asked, and when something matches it adds up to three one-line pointers to the runtime context. Nothing is injected when nothing matches. Runtime cost is zero model calls.
- **A web panel.** Open `http://127.0.0.1:8282/work-memory/` to search, replay a span, retitle an entry, or archive it.

## First run

The ledger starts empty. Build it from your existing history:

```bash
node cli/bootstrap.js --dry-run          # see what it would scan
node cli/bootstrap.js --all              # scan, import, group, index (needs a model key)
node cli/bootstrap.js --all --skip-llm   # only the steps that need no model
```

`--max-sessions N` caps how many conversations get grouped by the model, which is the main cost. Every stage can be re-run; finished conversations are skipped.

If another coding agent is installed on the machine (ZCode, Hermes, WorkBuddy), bootstrap imports its history into the same ledger and `memory_open` dispatches by source prefix.

## Requirements

- Node 22.19 or newer (`node:sqlite` and `zstd` are built in).
- For the offline grouping steps only: an OpenAI-compatible chat endpoint. Configure with `DSH_WM_LLM_BASE_URL`, `DSH_WM_LLM_MODEL`, `DSH_WM_LLM_API_KEY`. Without them, capture and retrieval still work — only bulk grouping is unavailable.

## Data

```
<DSH_HOME>/work-memory/hooks.jsonl   the ledger (append-only)
<DSH_HOME>/work-memory/topics.json   optional topic definitions
```

Nothing is written into your workspace. Every write takes a lock, keeps a backup, and rotates old backups.

## Limitations

- Retrieval is literal (CJK bigram plus Latin words). Synonyms are covered by an offline alias list, not by embeddings.
- Automatic entries are titled with the first sentence of the request; model-grouped entries get better titles.
- Cross-agent replay depends on the other agent's database schema.
- The panel needs one restart after install, because its routes are host-side code.
