import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSkillsSnapshotVersion,
  resetSkillsRefreshStateForTest,
} from "../skills/refresh-state.js";
import { createSkillsManageTool } from "./skills-manage-tool.js";

function makeSkillContent(name: string, body = "# Steps\n\nDo something useful.\n"): string {
  return ["---", `name: ${name}`, "description: Useful workflow", "---", "", body].join("\n");
}

describe("skills_manage tool", () => {
  let workspaceDir = "";

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-manage-"));
    resetSkillsRefreshStateForTest();
  });

  afterEach(async () => {
    resetSkillsRefreshStateForTest();
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("creates a new workspace skill and bumps snapshot version", async () => {
    const tool = createSkillsManageTool({ workspaceDir });
    const beforeVersion = getSkillsSnapshotVersion(workspaceDir);

    const result = await tool.execute("call-1", {
      action: "create",
      name: "demo-skill",
      content: makeSkillContent("demo-skill"),
    });

    const skillFile = path.join(workspaceDir, "skills", "demo-skill", "SKILL.md");
    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("name: demo-skill");
    expect(result.details).toMatchObject({
      ok: true,
      action: "create",
      name: "demo-skill",
      path: skillFile,
    });
    const afterVersion = getSkillsSnapshotVersion(workspaceDir);
    expect(afterVersion).toBeGreaterThan(beforeVersion);
  });

  it("rejects create when frontmatter name mismatches tool name", async () => {
    const tool = createSkillsManageTool({ workspaceDir });

    await expect(
      tool.execute("call-1", {
        action: "create",
        name: "demo-skill",
        content: makeSkillContent("other-skill"),
      }),
    ).rejects.toThrow("frontmatter name must equal tool name");
  });

  it("patches an existing skill and bumps snapshot version", async () => {
    const tool = createSkillsManageTool({ workspaceDir });
    const skillDir = path.join(workspaceDir, "skills", "demo-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), makeSkillContent("demo-skill"), "utf8");
    const beforeVersion = getSkillsSnapshotVersion(workspaceDir);

    const result = await tool.execute("call-2", {
      action: "patch",
      name: "demo-skill",
      old_string: "Do something useful.",
      new_string: "Do something even better.",
    });

    const updated = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    expect(updated).toContain("Do something even better.");
    expect(result.details).toMatchObject({
      ok: true,
      action: "patch",
      name: "demo-skill",
    });
    const afterVersion = getSkillsSnapshotVersion(workspaceDir);
    expect(afterVersion).toBeGreaterThan(beforeVersion);
  });

  it("rejects patch when old_string matches multiple locations", async () => {
    const tool = createSkillsManageTool({ workspaceDir });
    const skillDir = path.join(workspaceDir, "skills", "demo-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      makeSkillContent("demo-skill", "# Steps\n\nrepeat\nrepeat\n"),
      "utf8",
    );

    await expect(
      tool.execute("call-3", {
        action: "patch",
        name: "demo-skill",
        old_string: "repeat",
        new_string: "once",
      }),
    ).rejects.toThrow("old_string must uniquely match exactly one location");
  });

  it("rejects path-escape names", async () => {
    const tool = createSkillsManageTool({ workspaceDir });

    await expect(
      tool.execute("call-4", {
        action: "create",
        name: "../escape",
        content: makeSkillContent("escape"),
      }),
    ).rejects.toThrow("name must match");
  });
});
