import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { assertNoPathAliasEscape } from "../../infra/path-alias-guards.js";
import { isPathInside } from "../../infra/path-guards.js";
import { stringEnum } from "../schema/typebox.js";
import { parseFrontmatter } from "../skills/frontmatter.js";
import { bumpSkillsSnapshotVersion } from "../skills/refresh.js";
import { type AnyAgentTool, jsonResult, readStringParam, ToolInputError } from "./common.js";

const SKILLS_MANAGE_ACTIONS = ["create", "patch"] as const;
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_SKILL_FILE_BYTES = 512 * 1024;

const SkillsManageToolSchema = Type.Object({
  action: stringEnum(SKILLS_MANAGE_ACTIONS),
  name: Type.String({
    description: "Skill name (lowercase letters/digits plus - or _, max 64 chars).",
  }),
  content: Type.Optional(
    Type.String({
      description: "Full SKILL.md content (required for create).",
    }),
  ),
  old_string: Type.Optional(
    Type.String({
      description: "Text to find in SKILL.md (required for patch).",
    }),
  ),
  new_string: Type.Optional(
    Type.String({
      description: "Replacement text (required for patch, empty string allowed).",
    }),
  ),
});

function resolveSkillPaths(
  workspaceDir: string,
  skillName: string,
): {
  skillsRoot: string;
  skillDir: string;
  skillFile: string;
} {
  const skillsRoot = path.resolve(workspaceDir, "skills");
  const skillDir = path.resolve(skillsRoot, skillName);
  const skillFile = path.resolve(skillDir, "SKILL.md");
  if (!isPathInside(skillsRoot, skillFile)) {
    throw new ToolInputError(`skill path escapes workspace skills root: ${skillName}`);
  }
  return { skillsRoot, skillDir, skillFile };
}

function validateSkillName(skillName: string): void {
  if (!SKILL_NAME_RE.test(skillName)) {
    throw new ToolInputError(
      "name must match ^[a-z0-9][a-z0-9_-]{0,63}$ (lowercase letters/digits plus - or _)",
    );
  }
}

function ensureFrontmatterContent(content: string, skillName: string): void {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new ToolInputError("SKILL.md must start with YAML frontmatter (---)");
  }
  const frontmatter = parseFrontmatter(normalized);
  const frontmatterName = frontmatter.name?.trim();
  const description = frontmatter.description?.trim();
  if (!frontmatterName) {
    throw new ToolInputError("SKILL.md frontmatter requires name");
  }
  if (!description) {
    throw new ToolInputError("SKILL.md frontmatter requires description");
  }
  if (frontmatterName !== skillName) {
    throw new ToolInputError(
      `SKILL.md frontmatter name must equal tool name (${skillName}), got ${frontmatterName}`,
    );
  }
  if (Buffer.byteLength(content, "utf8") > MAX_SKILL_FILE_BYTES) {
    throw new ToolInputError(`SKILL.md content exceeds ${MAX_SKILL_FILE_BYTES} bytes`);
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const next = haystack.indexOf(needle, index);
    if (next === -1) {
      break;
    }
    count += 1;
    index = next + needle.length;
  }
  return count;
}

export function createSkillsManageTool(options?: { workspaceDir?: string }): AnyAgentTool {
  return {
    label: "Skills Manage",
    name: "skills_manage",
    description:
      "Create or patch workspace skills. Use create to add skills/<name>/SKILL.md, and patch to update an existing SKILL.md with a unique text replacement.",
    parameters: SkillsManageToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true, label: "action" });
      const skillName = readStringParam(params, "name", { required: true, label: "name" });
      const workspaceDir = options?.workspaceDir?.trim();
      if (!workspaceDir) {
        throw new ToolInputError("workspaceDir required for skills_manage");
      }
      validateSkillName(skillName);
      const { skillsRoot, skillDir, skillFile } = resolveSkillPaths(workspaceDir, skillName);
      await fs.mkdir(skillsRoot, { recursive: true });

      if (action === "create") {
        const content = readStringParam(params, "content", { required: true, label: "content" });
        ensureFrontmatterContent(content, skillName);
        await assertNoPathAliasEscape({
          absolutePath: skillFile,
          rootPath: skillsRoot,
          boundaryLabel: "workspace skills root",
        });
        const existing = await fs
          .stat(skillFile)
          .then(() => true)
          .catch(() => false);
        if (existing) {
          throw new ToolInputError(`skill already exists: ${skillName}`);
        }
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(skillFile, content, "utf8");
        const nextVersion = bumpSkillsSnapshotVersion({
          workspaceDir,
          reason: "manual",
          changedPath: skillFile,
        });
        return jsonResult({
          ok: true,
          action: "create",
          name: skillName,
          path: skillFile,
          version: nextVersion,
        });
      }

      if (action === "patch") {
        const oldString = readStringParam(params, "old_string", {
          required: true,
          label: "old_string",
        });
        if (!oldString) {
          throw new ToolInputError("old_string cannot be empty");
        }
        const newString = readStringParam(params, "new_string", {
          required: true,
          label: "new_string",
          allowEmpty: true,
        });
        await assertNoPathAliasEscape({
          absolutePath: skillFile,
          rootPath: skillsRoot,
          boundaryLabel: "workspace skills root",
        });
        const existing = await fs
          .stat(skillFile)
          .then(() => true)
          .catch(() => false);
        if (!existing) {
          throw new ToolInputError(`skill does not exist: ${skillName}`);
        }
        const source = await fs.readFile(skillFile, "utf8");
        const occurrences = countOccurrences(source, oldString);
        if (occurrences === 0) {
          throw new ToolInputError("old_string not found in SKILL.md");
        }
        if (occurrences > 1) {
          throw new ToolInputError("old_string must uniquely match exactly one location");
        }
        const updated = source.replace(oldString, newString);
        ensureFrontmatterContent(updated, skillName);
        await fs.writeFile(skillFile, updated, "utf8");
        const nextVersion = bumpSkillsSnapshotVersion({
          workspaceDir,
          reason: "manual",
          changedPath: skillFile,
        });
        return jsonResult({
          ok: true,
          action: "patch",
          name: skillName,
          path: skillFile,
          version: nextVersion,
        });
      }

      throw new ToolInputError(`Unknown action: ${action}`);
    },
  };
}
