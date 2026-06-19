import { tool } from "ai";
import { z } from "zod";
import {
  buildPreviewUrl,
  previewPortMax,
  previewPortMin,
  validatePreviewPort,
  waitForPort,
} from "../core/preview.js";
import type { ToolDefinition } from "../core/types.js";
import { PUBLISH_PREVIEW_TOOL_NAME } from "../constants/tool_names.js";

export const definition: ToolDefinition = {
  name: PUBLISH_PREVIEW_TOOL_NAME,
  description: "Public preview URL for a dev server in this container (call after Bash background start on 0.0.0.0)",
  isConcurrencySafe: () => true,
  shouldDefer: true,

  create() {
    return tool({
      description:
        "Return the public preview URL for a port. Use after starting a dev server with Bash (background: true) on 0.0.0.0.",
      inputSchema: z.object({
        port: z
          .number()
          .int()
          .min(previewPortMin())
          .max(previewPortMax())
          .describe("TCP port the dev server listens on inside the container"),
        label: z
          .string()
          .optional()
          .describe("Short label, e.g. frontend or api"),
        path: z
          .string()
          .optional()
          .describe("Optional path suffix appended to the preview URL, e.g. /docs"),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(60)
          .optional()
          .default(5)
          .describe("Seconds to wait for the port to start listening before reporting status"),
      }),
      execute: async (args: {
        port: number;
        label?: string;
        path?: string;
        wait_seconds?: number;
      }) => {
        const portError = validatePreviewPort(args.port);
        if (portError) return `Error: ${portError}`;

        const listening = await waitForPort(args.port, args.wait_seconds ?? 5);
        const url = buildPreviewUrl(args.port, args.path ?? "");

        if (!listening) {
          return `Port ${args.port} not listening. Start on 0.0.0.0, then retry.\nURL (when ready): ${url}`;
        }

        const label = args.label ? ` (${args.label})` : "";
        return `Preview${label}: ${url}`;
      },
    });
  },
};
