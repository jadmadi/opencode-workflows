# AGENTS.md

Guidance for agents working in this repository.

## What this is

An OpenCode V2 plugin (`workflows.ts`) that runs deterministic multi-agent
workflows. It registers a `workflow` command and ships the deep-research
workflow. No build step, no dependencies, AGPL-3.0-only.

## Local development

```sh
bun test
cp workflows.ts ~/.config/opencode/plugins/workflows.ts
touch ~/.config/opencode/plugins/workflows.ts
```

Check the server log when something is off:

```sh
grep workflows ~/.local/share/opencode/log/opencode.log | tail
```

## Hard constraints

- Do not import `@opencode/plugin`. Export a plain `{ id, setup }` object.
- Keep the plugin dependency-free. Use Bun globals for file access.
- Plugin `console` output is not visible to users. A command surfaces messages
  only by throwing.
- Never post a synthetic message for a notice; it starts a model turn.

## API notes

- Child sessions: `ctx.session.create({ title })`, `ctx.session.switchAgent`,
  `ctx.session.prompt({ sessionID, text })`, `ctx.session.wait({ sessionID })`,
  and `ctx.session.context({ sessionID })` to read the reply.
- Artifacts live under the data dir, keyed by run id. `WORKFLOW_ROOT` overrides
  the parent and tests rely on it.
- `WORKFLOW_RETRIES` and `WORKFLOW_CONCURRENCY` bound a run.

## Layout

- `listWorkflows`, `findWorkflow` - the registry, exported for tests.
- `runPhase`, `runWorkflow` - the runner, exported for tests.
- `replyText` - reads the last assistant text from a child session.
- `setup` on the plugin object - registers the `workflow` command.
- A run writes `00-task.txt` plus one artifact per phase, so a resume can skip
  completed phases and recover a missing task.
- `workflows.test.ts` - tests with a fake session API.

## Releasing

- Semantic commit messages. Changes through a feature branch and a PR.
- Keep `NOTICE` accurate.
