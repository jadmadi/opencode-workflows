import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin, {
  DEEP_RESEARCH,
  findWorkflow,
  listWorkflows,
  mapLimit,
  parseRun,
  replyText,
  runPhase,
  runWorkflow,
} from "./workflows.ts"

const tempDirs: string[] = []

afterEach(() => {
  delete process.env.WORKFLOW_ROOT
  delete process.env.WORKFLOW_RETRIES
  delete process.env.WORKFLOW_CONCURRENCY
  while (tempDirs.length) rmSync(tempDirs.pop() as string, { recursive: true, force: true })
})

function root() {
  const dir = mkdtempSync(join(tmpdir(), "workflows-test-"))
  tempDirs.push(dir)
  process.env.WORKFLOW_ROOT = dir
  return dir
}

function makeCtx(options: { failFirst?: number; reply?: (id: string) => string } = {}) {
  let counter = 0
  let reads = 0
  const created: string[] = []
  const prompts: any[] = []
  const models: any[] = []
  const commands: any[] = []
  const ctx: any = {
    session: {
      create: async () => {
        const id = `ses_${String(++counter).padStart(2, "0")}`
        created.push(id)
        return { id }
      },
      switchAgent: async () => {},
      switchModel: async (input: any) => void models.push(input),
      get: async () => ({ model: { providerID: "parent", id: "model" } }),
      prompt: async (input: any) => void prompts.push(input),
      wait: async () => {},
      context: async (input: any) => {
        reads += 1
        if (options.failFirst && reads <= options.failFirst) throw new Error("child failed")
        const text = options.reply ? options.reply(input.sessionID) : `reply from ${input.sessionID}`
        return [{ type: "assistant", content: [{ type: "text", text }] }]
      },
    },
    command: { transform: (callback: any) => callback({ add: (definition: any) => commands.push(definition) }) },
  }
  return { ctx, created, prompts, models, commands }
}

describe("registry", () => {
  test("lists and finds the built-in", () => {
    expect(listWorkflows()).toEqual(["deep-research"])
    expect(findWorkflow("deep-research")).toBe(DEEP_RESEARCH)
    expect(findWorkflow("nope")).toBeUndefined()
  })

  test("includes every context key even when outputs are long", () => {
    const results = { brief: "B".repeat(5000), research: "R".repeat(5000), reflect: "F".repeat(5000) }
    const write = DEEP_RESEARCH.phases.find((phase) => phase.name === "write")
    const prompt = write!.prompt("task", results, 0)
    expect(prompt).toContain("## brief")
    expect(prompt).toContain("## research")
    expect(prompt).toContain("## reflect")
  })
})

describe("replyText", () => {
  test("returns the last assistant text", () => {
    const messages = [
      { type: "user", text: "hi" },
      { type: "assistant", content: [{ type: "text", text: "first" }] },
      { type: "assistant", content: [{ type: "reasoning", text: "x" }, { type: "text", text: "second" }] },
    ]
    expect(replyText(messages)).toBe("second")
  })

  test("returns empty when there is no assistant text", () => {
    expect(replyText([{ type: "user", text: "hi" }])).toBe("")
    expect(replyText(undefined)).toBe("")
  })
})

describe("mapLimit", () => {
  test("keeps order and respects the limit", async () => {
    let active = 0
    let peak = 0
    const results = await mapLimit(5, 2, async (index) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active -= 1
      return String(index)
    })
    expect(results).toEqual(["0", "1", "2", "3", "4"])
    expect(peak).toBeLessThanOrEqual(2)
  })
})

describe("parseRun", () => {
  test("splits the name and task", () => {
    expect(parseRun("run deep-research quantum computing")).toEqual({ name: "deep-research", task: "quantum computing" })
  })

  test("reads a resume id", () => {
    expect(parseRun("run deep-research more work --resume=abc123")).toEqual({
      name: "deep-research",
      task: "more work",
      resume: "abc123",
    })
  })
})

describe("runPhase", () => {
  test("runs one child and writes an artifact", async () => {
    const dir = root()
    const { ctx, created } = makeCtx()
    const phase = { name: "brief", prompt: () => "do it" }
    const text = await runPhase(ctx, dir, phase, "task", {}, 0)
    expect(created).toHaveLength(1)
    expect(text).toBe("reply from ses_01")
    expect(existsSync(join(dir, "01-brief.md"))).toBe(true)
  })

  test("fans out and joins the replies", async () => {
    const dir = root()
    const { ctx, created } = makeCtx({ reply: (id) => `reply ${id}` })
    const phase = { name: "research", fanOut: 3, prompt: (_task: string, _results: any, index: number) => `angle ${index}` }
    const text = await runPhase(ctx, dir, phase, "task", {}, 2)
    expect(created).toHaveLength(3)
    expect(text.split("\n\n---\n\n")).toHaveLength(3)
  })

  test("retries then throws a clear error", async () => {
    const dir = root()
    process.env.WORKFLOW_RETRIES = "1"
    const { ctx, created } = makeCtx({ failFirst: 99 })
    const phase = { name: "brief", prompt: () => "do it" }
    await expect(runPhase(ctx, dir, phase, "task", {}, 0)).rejects.toThrow(/failed after 2 attempt/)
    expect(created).toHaveLength(2)
  })

  test("fails on an empty reply and writes nothing", async () => {
    const dir = root()
    process.env.WORKFLOW_RETRIES = "0"
    const { ctx, created } = makeCtx({ reply: () => "   " })
    const phase = { name: "brief", prompt: () => "do it" }
    await expect(runPhase(ctx, dir, phase, "task", {}, 0)).rejects.toThrow(/empty reply/)
    expect(existsSync(join(dir, "01-brief.md"))).toBe(false)
    expect(created).toHaveLength(1)
  })

  test("succeeds on the second attempt", async () => {
    const dir = root()
    process.env.WORKFLOW_RETRIES = "1"
    const { ctx, created } = makeCtx({ failFirst: 1 })
    const phase = { name: "brief", prompt: () => "do it" }
    const text = await runPhase(ctx, dir, phase, "task", {}, 0)
    expect(text).toContain("reply from")
    expect(created).toHaveLength(2)
  })
})

describe("runWorkflow", () => {
  test("runs every deep-research phase and writes the artifacts", async () => {
    const dir = root()
    const { ctx, created } = makeCtx({ reply: (id) => `output ${id}` })
    const result = await runWorkflow(ctx, "deep-research", "explain river deltas")
    expect(created).toHaveLength(8)
    expect(result.runDir.startsWith(dir)).toBe(true)
    expect(result.report).toContain("output")
    for (const name of ["01-brief.md", "02-plan.md", "03-research.md", "04-reflect.md", "05-write.md", "06-review.md"]) {
      expect(existsSync(join(result.runDir, name))).toBe(true)
    }
  })

  test("rejects an unknown workflow", async () => {
    root()
    const { ctx } = makeCtx()
    await expect(runWorkflow(ctx, "nope", "task")).rejects.toThrow(/unknown workflow/)
  })

  test("gives child sessions the parent model", async () => {
    root()
    const { ctx, models } = makeCtx()
    await runWorkflow(ctx, "deep-research", "task", undefined, "ses_parent")
    expect(models[0]).toEqual({ sessionID: "ses_01", model: { providerID: "parent", id: "model" } })
  })

  test("resumes from the last completed phase", async () => {
    root()
    const first = makeCtx({ reply: () => "phase one" })
    const started = await runWorkflow(first.ctx, "deep-research", "task")
    for (const name of ["04-reflect.md", "05-write.md", "06-review.md"]) unlinkSync(join(started.runDir, name))
    const second = makeCtx({ reply: () => "phase two" })
    const resumed = await runWorkflow(second.ctx, "deep-research", "task", started.runID)
    expect(resumed.runID).toBe(started.runID)
    expect(second.created).toHaveLength(3)
  })

  test("resumes without a task by reading the stored task", async () => {
    root()
    const first = makeCtx({ reply: () => "phase one" })
    const started = await runWorkflow(first.ctx, "deep-research", "my stored task")
    for (const name of ["04-reflect.md", "05-write.md", "06-review.md"]) unlinkSync(join(started.runDir, name))
    const second = makeCtx({ reply: () => "phase two" })
    const resumed = await runWorkflow(second.ctx, "deep-research", "", started.runID)
    expect(second.created).toHaveLength(3)
    expect(second.prompts.some((entry: any) => entry.text.includes("my stored task"))).toBe(true)
    expect(resumed.report).toContain("phase two")
  })
})

describe("setup", () => {
  test("registers the workflow command", async () => {
    const { ctx, commands } = makeCtx()
    await (plugin as any).setup(ctx)
    expect(commands.map((entry: any) => entry.name)).toEqual(["workflow"])
  })

  test("lists workflows and rejects a bare run", async () => {
    root()
    const { ctx, commands } = makeCtx()
    await (plugin as any).setup(ctx)
    const run = (text: string) => commands[0].execute({ sessionID: "ses_1", prompt: { text } })
    await expect(run("list")).rejects.toThrow(/deep-research/)
    await expect(run("run deep-research")).rejects.toThrow(/use \/workflow run/)
    await expect(run("what")).rejects.toThrow(/use \/workflow run/)
  })
})
