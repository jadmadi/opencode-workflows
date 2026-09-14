// OpenCode V2 workflows plugin.
//
// Runs deterministic multi-agent workflows. A workflow is an ordered list of
// phases. A phase either prompts one child session or fans out to several in
// parallel and joins their replies. Each phase writes an artifact under the
// data dir, so a run is auditable and resumable.
//
// The runtime does not resolve @opencode/plugin, so this file exports a plain
// { id, setup } object and uses Bun globals for file access.

const VERSION = "0.1.0"

type Results = Record<string, string>

interface Phase {
  name: string
  agent?: string
  fanOut?: number
  prompt: (task: string, results: Results, index: number) => string
}

interface Workflow {
  name: string
  description: string
  phases: Phase[]
}

function workflowsRoot(): string {
  if (process.env.WORKFLOW_ROOT) return process.env.WORKFLOW_ROOT
  const base = process.env.XDG_DATA_HOME || (process.env.HOME ? `${process.env.HOME}/.local/share` : undefined)
  return base ? `${base}/opencode/workflows` : ".opencode-workflows"
}

function maxRetries(): number {
  const value = Number(process.env.WORKFLOW_RETRIES)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 2
}

function concurrency(): number {
  const value = Number(process.env.WORKFLOW_CONCURRENCY)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 3
}

function parseModelRef(ref: string | undefined): { providerID: string; id: string } | undefined {
  if (!ref) return undefined
  const slash = ref.indexOf("/")
  if (slash < 1 || slash === ref.length - 1) return undefined
  return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1) }
}

async function resolveModel(ctx: any, sessionID: string | undefined): Promise<{ providerID: string; id: string } | undefined> {
  const override = parseModelRef(process.env.WORKFLOW_MODEL)
  if (override) return override
  if (!sessionID) return undefined
  const info: any = await ctx.session.get({ sessionID }).catch(() => undefined)
  return info?.model ?? info?.data?.model
}

function context(task: string, results: Results, keys: string[]): string {
  const budget = 8000
  const taskText = task.slice(0, 2000)
  const share = keys.length ? Math.max(600, Math.floor((budget - taskText.length) / keys.length)) : budget
  const blocks = keys
    .map((key) => {
      const value = results[key]
      return value ? `## ${key}\n${value.slice(0, share)}` : ""
    })
    .filter(Boolean)
    .join("\n\n")
  return [`Task: ${taskText}`, blocks].filter(Boolean).join("\n\n")
}

const DEEP_RESEARCH: Workflow = {
  name: "deep-research",
  description: "Multi-source research report: brief, plan, research, reflect, write, review",
  phases: [
    {
      name: "brief",
      prompt: (task) =>
        [
          "You are the research lead. Write a short brief for the task below.",
          "Cover the scope, the key questions, and the success criteria.",
          "Plain prose, no preamble.",
          "",
          `Task: ${task}`,
        ].join("\n"),
    },
    {
      name: "plan",
      prompt: (task, results) =>
        [
          "Plan three independent research angles for the task, using the brief.",
          "For each angle give a title and one sentence on what to find.",
          "",
          context(task, results, ["brief"]),
        ].join("\n"),
    },
    {
      name: "research",
      fanOut: 3,
      prompt: (task, results, index) =>
        [
          `Research angle ${index + 1} of 3. Use the plan below.`,
          "Collect concrete findings with sources where possible.",
          "Return prose with short headings, not a plan.",
          "",
          context(task, results, ["plan"]),
        ].join("\n"),
    },
    {
      name: "reflect",
      prompt: (task, results) =>
        [
          "Review the research below against the brief. Name gaps, conflicts, and weak claims.",
          "Be specific. Do not write the report yet.",
          "",
          context(task, results, ["brief", "plan", "research"]),
        ].join("\n"),
    },
    {
      name: "write",
      prompt: (task, results) =>
        [
          "Write the final Markdown report for the task.",
          "Use the brief, the research, and the reflection. Keep claims that survive the reflection.",
          "Include a short Sources section when the research named sources.",
          "",
          context(task, results, ["brief", "research", "reflect"]),
        ].join("\n"),
    },
    {
      name: "review",
      prompt: (task, results) =>
        [
          "Cold-review the report below. List unsupported claims and anything missing.",
          "Then give a one-line verdict.",
          "",
          context(task, results, ["write"]),
        ].join("\n"),
    },
  ],
}

const WORKFLOWS: Workflow[] = [DEEP_RESEARCH]

function listWorkflows(): string[] {
  return WORKFLOWS.map((workflow) => workflow.name)
}

function findWorkflow(name: string): Workflow | undefined {
  return WORKFLOWS.find((workflow) => workflow.name === name)
}

function artifactName(index: number, phase: string): string {
  return `${String(index + 1).padStart(2, "0")}-${phase}.md`
}

function replyText(messages: any): string {
  const list: any[] = Array.isArray(messages) ? messages : (messages?.data ?? [])
  for (let index = list.length - 1; index >= 0; index--) {
    const message = list[index]
    if (message?.type !== "assistant") continue
    const parts: any[] = Array.isArray(message.content) ? message.content : []
    const text = parts
      .filter((part) => part?.type === "text")
      .map((part) => part.text ?? "")
      .join("")
    if (text.trim()) return text.trim()
  }
  return ""
}

async function mapLimit(count: number, limit: number, callback: (index: number) => Promise<string>): Promise<string[]> {
  const results: string[] = new Array(count)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, count)) }, async () => {
    while (next < count) {
      const index = next
      next += 1
      results[index] = await callback(index)
    }
  })
  await Promise.all(workers)
  return results
}

async function runChild(
  ctx: any,
  agent: string | undefined,
  model: { providerID: string; id: string } | undefined,
  prompt: string,
): Promise<string> {
  const created: any = await ctx.session.create({ title: `workflow: ${prompt.slice(0, 40)}` })
  const sessionID = created?.id ?? created?.data?.id
  if (!sessionID) throw new Error("could not create a child session")
  if (agent) await ctx.session.switchAgent({ sessionID, agent })
  if (model) await ctx.session.switchModel({ sessionID, model })
  await ctx.session.prompt({ sessionID, text: prompt })
  await ctx.session.wait({ sessionID })
  return replyText(await ctx.session.context({ sessionID }))
}

async function runPhase(
  ctx: any,
  runDir: string,
  phase: Phase,
  task: string,
  results: Results,
  index: number,
  model?: { providerID: string; id: string },
): Promise<string> {
  const attempts = maxRetries() + 1
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      let text: string
      if (phase.fanOut && phase.fanOut > 1) {
        const replies = await mapLimit(phase.fanOut, concurrency(), (i) =>
          runChild(ctx, phase.agent, model, phase.prompt(task, results, i)),
        )
        if (replies.some((reply) => !reply.trim())) throw new Error("empty reply from child")
        text = replies.join("\n\n---\n\n")
      } else {
        text = await runChild(ctx, phase.agent, model, phase.prompt(task, results, 0))
      }
      if (!text.trim()) throw new Error("empty reply from child")
      await Bun.write(`${runDir}/${artifactName(index, phase.name)}`, text)
      return text
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`workflow phase "${phase.name}" failed after ${attempts} attempt(s): ${lastError}`)
}

async function runWorkflow(
  ctx: any,
  name: string,
  task: string,
  resume?: string,
  sessionID?: string,
): Promise<{ runID: string; runDir: string; report: string }> {
  const workflow = findWorkflow(name)
  if (!workflow) throw new Error(`unknown workflow "${name}"; available: ${listWorkflows().join(", ")}`)

  const runID = resume ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const runDir = `${workflowsRoot()}/${runID}`
  const results: Results = {}
  const model = await resolveModel(ctx, sessionID)

  // Persist the task on the first run so a later resume can omit it.
  const taskFile = `${runDir}/00-task.txt`
  if (resume && !task.trim()) {
    const stored = Bun.file(taskFile)
    if (await stored.exists()) task = (await stored.text()).trim()
    if (!task.trim()) throw new Error(`cannot resume run ${runID} without a task: the run has no stored task`)
  } else {
    await Bun.write(taskFile, task)
  }

  for (const [index, phase] of workflow.phases.entries()) {
    const file = `${runDir}/${artifactName(index, phase.name)}`
    if (resume) {
      const handle = Bun.file(file)
      const existing = (await handle.exists()) ? (await handle.text()).trim() : ""
      if (existing) {
        results[phase.name] = existing
        continue
      }
    }
    try {
      results[phase.name] = await runPhase(ctx, runDir, phase, task, results, index, model)
    } catch (error) {
      throw new Error(`${error} (run ${runID}, artifacts ${runDir})`)
    }
  }

  const last = workflow.phases[workflow.phases.length - 1]
  return { runID, runDir, report: results["write"] ?? results[last?.name ?? ""] ?? "" }
}

function parseRun(text: string): { name: string; task: string; resume?: string } {
  const rest = text.slice(4).trim()
  const space = rest.indexOf(" ")
  const name = space === -1 ? rest : rest.slice(0, space)
  let task = space === -1 ? "" : rest.slice(space + 1).trim()
  let resume: string | undefined
  const match = task.match(/(?:^|\s)--resume=([A-Za-z0-9-]+)\s*$/)
  if (match) {
    resume = match[1]
    task = task.slice(0, match.index).trim()
  }
  return { name, task, resume }
}

const plugin = {
  id: "workflows",
  async setup(ctx: any) {
    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "workflow",
        description: "Run a deterministic multi-agent workflow",
        execute: async ({ sessionID, prompt }: any) => {
          const text = typeof prompt?.text === "string" ? prompt.text.trim() : ""
          if (!text || text.toLowerCase() === "list") {
            throw new Error(`Workflows: ${listWorkflows().join(", ")}\nworkflows ${VERSION}`)
          }
          if (!text.startsWith("run ")) {
            throw new Error("use /workflow run <name> <task>, or /workflow list")
          }
          const { name, task, resume } = parseRun(text)
          if (!task && !resume) throw new Error("use /workflow run <name> <task>")
          const result = await runWorkflow(ctx, name, task, resume, sessionID)
          throw new Error(`Workflow "${name}" finished. Run ${result.runID}. Artifacts: ${result.runDir}`)
        },
      })
    })
  },
}

export { DEEP_RESEARCH, findWorkflow, listWorkflows, mapLimit, parseRun, replyText, runPhase, runWorkflow, VERSION }
export default plugin
