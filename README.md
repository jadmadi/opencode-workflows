# opencode-workflows

An OpenCode V2 plugin that runs deterministic multi-agent workflows. A workflow
is an ordered list of phases. A phase either prompts one child session or fans
out to several in parallel and joins their results. Each phase writes an
artifact, so a run is auditable and resumable.

## Install

```sh
mkdir -p ~/.config/opencode/plugins
curl -fsSL \
  https://raw.githubusercontent.com/jadmadi/opencode-workflows/main/workflows.ts \
  -o ~/.config/opencode/plugins/workflows.ts
```

For one project, put it in `.opencode/plugins/`. Tested against OpenCode
`0.0.0-beta-19425`.

## Use

| Command                          | Effect                                  |
| -------------------------------- | --------------------------------------- |
| `/workflow` or `/workflow list`  | List the built-in workflows             |
| `/workflow run <name> <task>`    | Run a workflow for the task             |

First built-in: `deep-research`, with the phases brief, plan, research, reflect,
write, and review. It produces one Markdown report. `fact-check` is a follow-up.

## How it runs

- Each phase creates child sessions with `ctx.session.create`, selects an agent
  with `ctx.session.switchAgent`, sends the prompt with `ctx.session.prompt`,
  and waits with `ctx.session.wait`.
- A fan-out phase runs several children in parallel, bounded by
  `WORKFLOW_CONCURRENCY` (default 3), and joins their replies.
- A failed phase retries up to `WORKFLOW_RETRIES` (default 2) before the run
  stops and reports.
- Artifacts go under `<data dir>/opencode/workflows/<runID>/`. `WORKFLOW_ROOT`
  overrides the parent.

## Tests

```sh
bun test
```

## Attribution

Inspired by MiMoCode's workflows. See `NOTICE`.

## License

MIT
