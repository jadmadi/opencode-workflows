# Contributing

Thanks for helping improve opencode-workflows.

## Setup

```sh
git clone https://github.com/jadmadi/opencode-workflows
cd opencode-workflows
bun test
```

Bun is a deliberate exception to the global no-bun rule here: the plugin runs
inside OpenCode, which embeds Bun.

## Rules

- No imports in the plugin. Export a plain `{ id, setup }` object.
- Keep phases deterministic: a phase is a prompt, a fan-out, or a join.
- Add a test for any behavior you change. Tests use a fake session API.

## Sending a change

1. Branch: `git checkout -b fix/short-description`.
2. Make the change and add tests.
3. Run `bun test`.
4. Use a semantic commit message.
5. Open a pull request against `main`.

## License

By contributing, you agree that your work is released under the MIT License.
