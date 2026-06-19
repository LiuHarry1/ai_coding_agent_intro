import { MCPManager } from "../core/mcp-manager.js";
import { configManager } from "../core/config-manager.js";
import { getDefaultWorkspace } from "../core/workspace.js";
import { loadPlugins } from "../core/plugins/index.js";
import type { MCPServerConfig } from "../core/types.js";

export const mcpManager = new MCPManager();

/**
 * Resolve MCP servers from config plus declarative plugins (scoped to the
 * default workspace). Config-level servers WIN on name collision — a plugin
 * shouldn't be able to silently shadow a user-configured server.
 */
async function resolveMCPServers(): Promise<Record<string, MCPServerConfig>> {
  const configServers = configManager.get("mcpServers");
  let pluginServers: Record<string, MCPServerConfig> = {};
  try {
    pluginServers = (await loadPlugins(getDefaultWorkspace())).mcpServers;
  } catch (err) {
    console.warn(`[mcp] plugin MCP discovery failed: ${(err as Error).message}`);
  }
  return { ...pluginServers, ...configServers };
}

export async function syncMCPFromConfig(): Promise<void> {
  await mcpManager.closeAll();
  const servers = await resolveMCPServers();
  for (const [name, config] of Object.entries(servers)) {
    await mcpManager.addServer(name, config);
  }
}

export function initMcpLifecycle(): void {
  configManager.load();
  syncMCPFromConfig().catch((err) => {
    console.error(`[mcp] Failed to sync from config: ${err.message}`);
  });

  configManager.onChange("mcpServers", () => {
    syncMCPFromConfig().catch((err) => {
      console.error(`[mcp] Failed to re-sync after config change: ${err.message}`);
    });
  });

  process.on("exit", () => {
    mcpManager.closeAll().catch(() => {});
  });
}
