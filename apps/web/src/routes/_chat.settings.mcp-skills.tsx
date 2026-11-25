import { createFileRoute } from "@tanstack/react-router";

import { AgentConfigSettingsPanel } from "../components/settings/AgentConfigSettings";

export const Route = createFileRoute("/_chat/settings/mcp-skills")({
  component: AgentConfigSettingsPanel,
});
