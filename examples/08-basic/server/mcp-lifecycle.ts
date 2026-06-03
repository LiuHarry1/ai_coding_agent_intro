import { MCPManager } from "../core/mcp-manager.js";
import { configManager } from "../core/config-manager.js";

export const mcpManager = new MCPManager();

export async function syncMCPFromConfig(): Promise<void> {
  await mcpManager.closeAll();
  const servers = configManager.get("mcpServers");
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
