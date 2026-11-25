import { useGT } from "gt-react";
import type { ReactNode } from "react";
import { EllipsisIcon } from "lucide-react";
import {
  Menu,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

export function CompactComposerControlsMenu(props: {
  account?: ReactNode;
  reasoning?: { label: string; content: ReactNode } | undefined;
  size?: "sm" | "xs";
  /** Close the portaled popup when its trigger hides. */
  hidden?: boolean;
}) {
  const gt = useGT();
  const composerFloatingLayerProps = useComposerMenuProps();
  const size = props.size ?? "sm";
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const sections = [
    props.reasoning ? (
      <MenuSub key="reasoning">
        <MenuSubTrigger>{props.reasoning.label}</MenuSubTrigger>
        <MenuSubPopup {...composerFloatingLayerProps}>{props.reasoning.content}</MenuSubPopup>
      </MenuSub>
    ) : null,
    props.account ? <div key="account">{props.account}</div> : null,
  ].filter((section) => section !== null);
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <ComposerControl
            size={size}
            className="shrink-0"
            aria-label={gt("More composer controls")}
            data-composer-shortcut={props.reasoning ? "composer.effort" : undefined}
          />
        }
      >
        <ComposerControlIcon icon={EllipsisIcon} size={size} />
      </MenuTrigger>
      <MenuPopup align="end" {...composerFloatingLayerProps}>
        {sections.flatMap((section) =>
          section === sections[0]
            ? [section]
            : [<MenuSeparator key={`separator-${section.key}`} />, section],
        )}
      </MenuPopup>
    </Menu>
  );
}
