import { describe, expect, it } from "vite-plus/test";

import { groupSkillsByScope } from "./ComposerSkillPicker.logic";

const skill = (name: string, scope?: string, path = `/home/me/.claude/skills/${name}`) => ({
  name,
  path,
  ...(scope ? { scope } : {}),
});

describe("groupSkillsByScope", () => {
  it("puts repo, project and local skills under Project and the rest under Global", () => {
    const groups = groupSkillsByScope([
      skill("personal", "user"),
      skill("repo", "repo"),
      skill("system", "system"),
      skill("local", "local"),
      skill("unscoped"),
      skill("plugin", "repo", "/home/me/.codex/plugins/acme/skills/plugin"),
      skill("project", "project"),
    ]);
    expect(groups.map((group) => [group.scope, group.items.map((item) => item.name)])).toEqual([
      ["project", ["repo", "local", "project"]],
      ["global", ["personal", "system", "unscoped", "plugin"]],
    ]);
  });

  it("leaves out an empty group", () => {
    expect(groupSkillsByScope([skill("personal", "user")]).map((group) => group.scope)).toEqual([
      "global",
    ]);
  });
});
