---
feature: workflow-runner
status: delivered
updated: 2026-09-12
branch: feat/workflows
commits: 04a98d3..b1cc7a8
---

# Workflow Runner

## Report

**What was built** - A single-file OpenCode V2 plugin that runs deterministic
multi-agent workflows. It registers a `workflow` command and ships deep-research
with the phases brief, plan, research, reflect, write, and review. Each phase
creates one child session, or fans out to several in parallel and joins their
replies. Every phase writes an artifact under the data dir, and the run stores
its task so a resume can continue. Child sessions inherit the invoking session's
model, and `WORKFLOW_MODEL` overrides it.

**Verification** - `bun test`: 21 pass, 0 fail, 48 assertions. Live post-fix run
on the DeepSeek platform: deep-research produced `00-task.txt` plus the six
artifacts and returned the run id and artifact path. An earlier live run exposed
a context-truncation bug, fixed and re-verified. Three review rounds covered two
blocking items, one partially resolved follow-up, and several lows; all are
resolved.

**Journey log**

1. The first live run showed the reflection never reached the write phase,
   because `context()` truncated by key order. Each key now gets a share, and the
   task is capped.
2. A blank child reply was written as a successful artifact, and a zero-byte
   artifact then passed resume. Blank replies now fail the phase, in the single
   and fan-out paths alike.
3. A taskless resume sent an empty task. The first run stores the task, and a
   resume reads it back or fails clearly.

## [S1] Problem

OpenCode V2 has no deterministic multi-agent workflows. Every run is
conversational, so a known phase sequence cannot run unattended. MiMoCode ships
JavaScript workflows (deep-research, fact-check, research-experiment, compose)
that encode fixed phases with bounded retries and automatic parallelization.

## [S2] Design

A plugin provides a small runner and one built-in workflow, deep-research.
Fact-check is a follow-up delivery.

- A `workflow` tool and a `/workflow` command start a run. Input names the
  workflow and the task text.
- The runner executes ordered phases. A phase may fan out to parallel child
  sessions with a concurrency cap, then join.
- Each child session is created with `ctx.session.create`, given an agent with
  `ctx.session.switchAgent`, prompted with `ctx.session.prompt`, and awaited
  with `ctx.session.wait`. Child results are read with `ctx.session.context`.
- Phases write artifacts to a run directory under the data dir, so a run is
  resumable and auditable.
- Bounded retries: a phase retries on a failed result up to a small cap, then
  stops the run and reports.
- First delivery: deep-research (brief, plan, research, reflect, write, review).
  It reads and writes files and needs no user interaction.

## [S3] Out of Scope

- A sandboxed JavaScript runtime for user-authored workflows. Phase two.
- The full compose pipeline and the research-experiment loop.
- The fact-check workflow. It is a follow-up delivery.
- A TUI progress view.
- Cost accounting.

## Tasks

- [ ] T1: runner core with ordered phases, parallel fan-out, a join, and
      `ctx.session.wait` - acceptance: a fake-context test runs a two-phase
      workflow with one fan-out and asserts the phase order and the joined
      result (covers: S2)
- [ ] T2: artifact directory and resume support - acceptance: a test writes an
      artifact per phase and a re-run resumes from the last completed phase
      (covers: S2; depends: T1)
- [ ] T3: bounded retries and a clear failure report - acceptance: a test forces
      a phase to fail twice and confirms the run stops with a report (covers:
      S2; depends: T1)
- [ ] T4: the deep-research workflow - acceptance: a fake-context run reaches
      the write phase and produces one report file (covers: S2; depends: T2)
- [ ] T5: README, NOTICE, and tests for deep-research - acceptance: files exist,
      tests pass (covers: S2; depends: T4)
