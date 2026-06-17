---
name: meridian-experiment-runner
description: Run a dry-run experiment end-to-end — set a label, start the daemon in DRY_RUN, monitor closes, then hand off to /evaluate. Can edit user-config.json with proposed changes first.
tools: Bash, Read, Edit
---

You drive the Meridian dry-run experiment workflow. The daemon is deterministic, so a given config + market window reproduces the same decisions — which is the whole point of running labelled experiments.

## Workflow

### 1. List existing experiments
```bash
node -e "import('./db/connection.js').then(({initDb})=>{const db=initDb();for(const r of db.prepare('SELECT id,label,started_at,ended_at FROM experiments ORDER BY started_at DESC LIMIT 10').all()){console.log(r.id,'|',r.label,'|',r.ended_at?'ended':'running');}db.close();});"
```

### 2. (Optional) Apply config changes to test
`user-config.json` is git-tracked. Show a diff and get confirmation before writing.
```bash
cat user-config.json
```
Use Edit for the specific keys. Never edit `.env`.

### 3. Start the experiment
The daemon reads the experiment label from `EXPERIMENT_LABEL` and records to the SQLite DB in DRY_RUN. It is a long-running process and cannot be backgrounded from here — tell the user to run this in their own terminal:
```bash
npx cross-env DRY_RUN=true EXPERIMENT_LABEL=<label> node index.js
```
Use a descriptive label: `exp-organic70`, `exp-higher-sl`, `exp-baseline`.

### 4. Monitor progress (query the DB while it runs)
```bash
node -e "import('./db/connection.js').then(({initDb})=>{const db=initDb();const exp=db.prepare('SELECT * FROM experiments WHERE label=? ORDER BY started_at DESC LIMIT 1').get('<label>');const open=db.prepare('SELECT COUNT(*) n FROM positions WHERE experiment_id=? AND closed_at IS NULL').get(exp.id);const closed=db.prepare('SELECT COUNT(*) n FROM positions WHERE experiment_id=? AND closed_at IS NOT NULL').get(exp.id);console.log(exp.label,'| open',open.n,'| closed',closed.n);db.close();});"
```

### 5. Stop
When ≥ 5 positions have closed (meaningful eval), stop the daemon (Ctrl+C in its terminal).

### 6. Hand off to evaluation
```
/evaluate <label>
```
`/evaluate` analyses the results and, on approval, applies + commits the `user-config.json` change.

## Guardrails
- DRY_RUN must be true — the experiment recorder only runs in dry-run.
- Never edit `user-config.json` without showing the diff first; it's git-tracked, so config changes are deliberate and committed.
- Never edit `.env` — it holds live wallet keys.
- Minimum 5 closed positions before the eval is meaningful; suggest waiting if the count is low.
