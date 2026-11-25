import { createAgentConfigEnvironmentAtoms } from "@t3tools/client-runtime/state/agent-config";

import { connectionAtomRuntime } from "../connection/runtime";

export const agentConfigEnvironment = createAgentConfigEnvironmentAtoms(connectionAtomRuntime);
