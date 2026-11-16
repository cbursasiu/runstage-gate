import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { aiDetectionSchema } from "./ai.ts";

const base = {
  name: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9._-]+$/, "use letters, digits, dot, dash or underscore"),
  required: z.boolean().default(true),
  timeout_seconds: z.number().int().positive().max(3600).default(300),
};

export const scriptCheckSchema = z
  .object({
    ...base,
    type: z.literal("script"),
    /** Shell command run with bash from the repo root. */
    run: z.string().min(1),
  })
  .strict();

export const agentCheckSchema = z
  .object({
    ...base,
    type: z.literal("agent"),
    /** Which already-installed agent CLI to call. */
    agent: z.enum(["claude-code", "codex", "custom"]),
    /** Instructions for the agent. The diff is appended after it on stdin. */
    prompt: z.string().min(1),
    /** Override the command. Defaults: claude-code -> `claude -p`, codex -> `codex exec -`. */
    command: z.string().min(1).optional(),
    /** Agent checks default to optional so a flaky model does not block merges by accident. */
    required: z.boolean().default(false),
  })
  .strict()
  .refine((c) => c.agent !== "custom" || !!c.command, {
    message: "agent: custom needs a command",
    path: ["command"],
  });

export const checkSchema = z.union([scriptCheckSchema, agentCheckSchema]);

export const gateConfigSchema = z
  .object({
    /** Optional schema URL/path for editors. Stripped after parse; not part of the runtime config. */
    $schema: z.string().min(1).optional(),
    version: z.literal(1),
    agents: z
      .object({
        /** Agent checks are skipped unless this is true (and the runner allows it). */
        enabled: z.boolean().default(false),
      })
      .strict()
      .default({ enabled: false }),
    checks: z.array(checkSchema).min(1, "define at least one check"),
    /** Detect AI-generated changes and apply extra policy to them. Off by default. */
    ai_detection: aiDetectionSchema,
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    cfg.checks.forEach((c, i) => {
      if (seen.has(c.name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate check name "${c.name}"`, path: ["checks", i, "name"] });
      }
      seen.add(c.name);
    });
    cfg.ai_detection.policy.require_checks.forEach((name, i) => {
      if (!seen.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unknown check "${name}"`,
          path: ["ai_detection", "policy", "require_checks", i],
        });
      }
    });
  })
  .transform(({ $schema: _schema, ...cfg }) => cfg);

export type GateConfig = z.infer<typeof gateConfigSchema>;
export type CheckDefinition = GateConfig["checks"][number];
export type ScriptCheck = z.infer<typeof scriptCheckSchema>;
export type AgentCheck = z.infer<typeof agentCheckSchema>;

export const GATE_CONFIG_PATH = ".runstage/gate.yml";

export class GateConfigError extends Error {
  constructor(message: string, readonly issues: string[] = []) {
    super(issues.length ? `${message}:\n- ${issues.join("\n- ")}` : message);
    this.name = "GateConfigError";
  }
}

/** Parse and validate the YAML text of a .runstage/gate.yml file. */
export function parseGateConfig(text: string): GateConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new GateConfigError(`invalid YAML: ${(err as Error).message}`);
  }
  const parsed = gateConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GateConfigError(
      "invalid gate config",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return parsed.data;
}
