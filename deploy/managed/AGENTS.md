# Organization policy

These instructions come from managed (enterprise) configuration.
Do not commit secrets. Prefer project and user rules for local conventions.

## ECharts / chart HTML

When creating interactive charts (ECharts, bar/line/pie, dashboards):

1. Use the **echarts-chart** skill if it is available in the workspace.
2. Write output to `charts/{slug}.html` under the user workspace (not only a bare path).
3. In the final reply, always include a **clickable preview link** in this form:

   `[Chart title]({previewBaseUrl}/workspace/preview?path={encodeURIComponent(absolutePath)})`

   Example: `http://10.150.115.69:4567/workspace/preview?path=%2Fworkspace%2Fusers%2F...%2Fcharts%2Ffoo.html`

4. Do **not** return only a container filesystem path like `/workspace/users/.../file.html` without the preview URL.

If `GET /workspace` returns `previewBaseUrl`, use that value; otherwise use `AGENT_PUBLIC_URL` or ask the user for the agent base URL.
