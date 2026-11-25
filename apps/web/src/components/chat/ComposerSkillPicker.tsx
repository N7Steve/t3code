import type { ServerProviderSkill } from "@t3tools/contracts";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import { T, useGT } from "gt-react";
import { PackageIcon } from "lucide-react";
import { memo, useRef, useState } from "react";

import { searchProviderSkills } from "../../providerSkillSearch";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useComposerMenuProps } from "./composerEventScope";
import { groupSkillsByScope, type SkillScopeGroup } from "./ComposerSkillPicker.logic";

/**
 * Browse the selected provider's skills, project ones apart from global ones, and insert one as
 * the same `$skill` chip typing makes.
 */
export const ComposerSkillPicker = memo(function ComposerSkillPicker(props: {
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly onSelect: (skill: ServerProviderSkill) => void;
}) {
  const gt = useGT();
  const { finalFocus: focusComposer, ...floatingLayerProps } = useComposerMenuProps();
  const [query, setQuery] = useState("");
  // The insertion places the caret after the chip, so closing must not move focus again.
  const insertedRef = useRef(false);
  const allSkills = searchProviderSkills(props.skills, "");
  if (allSkills.length === 0) return null;
  const items = groupSkillsByScope(allSkills);
  const filteredItems = query.trim()
    ? groupSkillsByScope(searchProviderSkills(props.skills, query))
    : items;
  const scopeLabel: Record<SkillScopeGroup, string> = {
    project: gt("Project", { $context: "heading for skills from the current project" }),
    global: gt("Global", { $context: "heading for skills available in every project" }),
  };

  return (
    <Combobox
      items={items}
      filteredItems={filteredItems}
      autoHighlight
      value={null}
      itemToStringLabel={(skill: ServerProviderSkill) => formatProviderSkillDisplayName(skill)}
      isItemEqualToValue={(a: ServerProviderSkill, b: ServerProviderSkill) => a.name === b.name}
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
      onValueChange={(skill: ServerProviderSkill | null) => {
        if (!skill) return;
        insertedRef.current = true;
        props.onSelect(skill);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComboboxTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={gt("Attach skill")}
                />
              }
            />
          }
        >
          <PackageIcon />
        </TooltipTrigger>
        <TooltipPopup>
          <T>Attach skill</T>
        </TooltipPopup>
      </Tooltip>
      <ComboboxPopup
        align="start"
        side="top"
        className="w-80"
        {...floatingLayerProps}
        finalFocus={() => {
          if (insertedRef.current) {
            insertedRef.current = false;
            return false;
          }
          return focusComposer ? focusComposer() : true;
        }}
      >
        <ComboboxSearchInput
          aria-label={gt("Search skills")}
          placeholder={gt("Search skills")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>
          <T>No matching skills.</T>
        </ComboboxEmpty>
        <ComboboxList>
          {(group: (typeof items)[number]) => (
            <ComboboxGroup key={group.scope} items={group.items}>
              <ComboboxGroupLabel>{scopeLabel[group.scope]}</ComboboxGroupLabel>
              <ComboboxCollection>
                {(skill: ServerProviderSkill) => {
                  const description = skill.shortDescription ?? skill.description;
                  return (
                    <ComboboxItem key={skill.name} value={skill}>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{formatProviderSkillDisplayName(skill)}</span>
                        {description ? (
                          <span className="truncate text-muted-foreground text-xs">
                            {description}
                          </span>
                        ) : null}
                      </span>
                    </ComboboxItem>
                  );
                }}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
});
