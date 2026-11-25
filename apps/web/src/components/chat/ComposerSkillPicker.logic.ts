import { resolveProviderSkillSourceKind } from "@t3tools/client-runtime/providerSkills";
import type { ServerProviderSkill } from "@t3tools/contracts";

export type SkillScopeGroup = "project" | "global";

/**
 * Skills from the project's own folders (repo, project, local scopes) versus the ones that follow
 * the user everywhere: personal, system, plugin-provided, and any scope a provider leaves unset.
 */
function skillScopeGroup(skill: Pick<ServerProviderSkill, "path" | "scope">): SkillScopeGroup {
  const kind = resolveProviderSkillSourceKind(skill);
  return kind === "repo" || kind === "project" ? "project" : "global";
}

/** Project skills first, then global ones; empty groups are left out. */
export function groupSkillsByScope<Skill extends Pick<ServerProviderSkill, "path" | "scope">>(
  skills: ReadonlyArray<Skill>,
): Array<{ scope: SkillScopeGroup; items: Skill[] }> {
  const project: Skill[] = [];
  const global: Skill[] = [];
  for (const skill of skills) {
    (skillScopeGroup(skill) === "project" ? project : global).push(skill);
  }
  return [
    ...(project.length > 0 ? [{ scope: "project" as const, items: project }] : []),
    ...(global.length > 0 ? [{ scope: "global" as const, items: global }] : []),
  ];
}
