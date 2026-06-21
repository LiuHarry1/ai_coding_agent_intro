"""Server-rendered HTML dashboard.

Renders summary cards, a daily tokens/cost time series, per-model cost
breakdown, and a per-user leaderboard. Data is queried server-side (reusing
the stats functions) and embedded into the page, so the browser needs no API
key and there are no CORS concerns. Charts are drawn with Chart.js (CDN); if
the CDN is unreachable the tables still render.

Auth: when `ANALYTICS_QUERY_API_KEY` is set, the page requires a matching
`?key=` query parameter (browsers can't easily send custom headers on a
navigation).
"""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import HTMLResponse

from ..config import get_settings
from ..database import AsyncSessionLocal
from . import stats

router = APIRouter(tags=["dashboard"])


async def _collect_data() -> dict:
    async with AsyncSessionLocal() as db:
        summary = await stats.summary(db=db)
        daily = await stats.grouped_usage(db=db, group_by="day", limit=365)
        by_model = await stats.grouped_usage(db=db, group_by="model", limit=50)
        users = await stats.per_user(db=db, limit=50)
        questions = await stats.questions_per_user(db=db, limit=50)
        q_by_user = {q.user_email: q.questions for q in questions}
        users_with_questions = [
            {**u.model_dump(), "questions": q_by_user.get(u.key, 0)} for u in users
        ]
        return {
            "summary": summary.model_dump(),
            "daily": [r.model_dump() for r in daily],
            "by_model": [r.model_dump() for r in by_model],
            "users": users_with_questions,
            "questions": [q.model_dump() for q in questions],
        }


@router.get("/dashboard", response_class=HTMLResponse)
async def dashboard(key: str | None = Query(default=None)) -> HTMLResponse:
    expected = get_settings().query_api_key
    if expected and key != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Append ?key=<ANALYTICS_QUERY_API_KEY> to view the dashboard",
        )
    data = await _collect_data()
    html = _PAGE.replace("__DATA__", json.dumps(data))
    return HTMLResponse(content=html)


_PAGE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Coding Agent Analytics</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  :root { color-scheme: light dark; --bg:#0b0d12; --card:#161a22; --fg:#e8ecf3; --mut:#93a0b4; --acc:#6aa3ff; --line:#222836; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--fg); }
  header { padding:20px 28px; border-bottom:1px solid var(--line); display:flex; align-items:baseline; gap:16px; }
  header h1 { font-size:18px; margin:0; font-weight:650; }
  header .sub { color:var(--mut); font-size:13px; }
  main { padding:24px 28px; max-width:1200px; margin:0 auto; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:14px; margin-bottom:24px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px 18px; }
  .card .label { color:var(--mut); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .card .value { font-size:24px; font-weight:680; margin-top:6px; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:18px; margin-bottom:24px; }
  @media (max-width:860px){ .grid2 { grid-template-columns:1fr; } }
  .panel { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px; }
  .panel h2 { font-size:14px; margin:0 0 14px; font-weight:600; color:var(--fg); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); }
  th { color:var(--mut); font-weight:550; }
  td.num,th.num { text-align:right; font-variant-numeric:tabular-nums; }
  .empty { color:var(--mut); padding:24px; text-align:center; }
  footer { color:var(--mut); font-size:12px; padding:16px 28px; }
  a { color:var(--acc); }
</style>
</head>
<body>
<header>
  <h1>Coding Agent Analytics</h1>
  <span class="sub" id="sub"></span>
</header>
<main>
  <section class="cards" id="cards"></section>
  <section class="grid2">
    <div class="panel"><h2>Daily tokens &amp; cost</h2><canvas id="dailyChart" height="120"></canvas><div id="dailyEmpty"></div></div>
    <div class="panel"><h2>Cost by model</h2><canvas id="modelChart" height="120"></canvas><div id="modelEmpty"></div></div>
  </section>
  <section class="panel">
    <h2>Top users by cost</h2>
    <table id="usersTable"><thead><tr>
      <th>User</th><th class="num">Questions</th><th class="num">LLM calls</th><th class="num">Input</th><th class="num">Output</th><th class="num">Total tokens</th><th class="num">Cost (USD)</th>
    </tr></thead><tbody></tbody></table>
    <div id="usersEmpty"></div>
  </section>
</main>
<footer>Auto-refreshes every 30s · <a href="/docs">API docs</a></footer>

<script>
const DATA = __DATA__;
const nf = new Intl.NumberFormat();
const cf = (n) => "$" + Number(n).toFixed(4);

function renderCards() {
  const s = DATA.summary;
  const items = [
    ["Total cost", cf(s.cost_usd)],
    ["User questions", nf.format(s.questions ?? 0)],
    ["LLM calls", nf.format(s.calls)],
    ["Sessions", nf.format(s.sessions)],
    ["Users", nf.format(s.users)],
    ["Input tokens", nf.format(s.input_tokens)],
    ["Output tokens", nf.format(s.output_tokens)],
    ["Total tokens", nf.format(s.total_tokens)],
  ];
  document.getElementById("cards").innerHTML = items.map(
    ([l, v]) => `<div class="card"><div class="label">${l}</div><div class="value">${v}</div></div>`
  ).join("");
  document.getElementById("sub").textContent = "generated " + new Date().toLocaleString();
}

function renderUsers() {
  const tb = document.querySelector("#usersTable tbody");
  if (!DATA.users.length) { document.getElementById("usersEmpty").innerHTML = '<div class="empty">No data yet.</div>'; return; }
  tb.innerHTML = DATA.users.map(u => `<tr>
    <td>${u.key}</td>
    <td class="num">${nf.format(u.questions ?? 0)}</td>
    <td class="num">${nf.format(u.calls)}</td>
    <td class="num">${nf.format(u.input_tokens)}</td>
    <td class="num">${nf.format(u.output_tokens)}</td>
    <td class="num">${nf.format(u.total_tokens)}</td>
    <td class="num">${cf(u.cost_usd)}</td>
  </tr>`).join("");
}

function drawCharts() {
  if (typeof Chart === "undefined") return; // CDN blocked → tables only
  if (DATA.daily.length) {
    new Chart(document.getElementById("dailyChart"), {
      data: {
        labels: DATA.daily.map(d => d.key),
        datasets: [
          { type: "bar", label: "Total tokens", yAxisID: "y", data: DATA.daily.map(d => d.total_tokens), backgroundColor: "rgba(106,163,255,.5)" },
          { type: "line", label: "Cost (USD)", yAxisID: "y1", data: DATA.daily.map(d => d.cost_usd), borderColor: "#ffb86a", tension: .3 },
        ],
      },
      options: { responsive: true, scales: { y: { position: "left" }, y1: { position: "right", grid: { drawOnChartArea: false } } } },
    });
  } else { document.getElementById("dailyEmpty").innerHTML = '<div class="empty">No data yet.</div>'; }

  if (DATA.by_model.length) {
    new Chart(document.getElementById("modelChart"), {
      type: "bar",
      data: { labels: DATA.by_model.map(m => m.key), datasets: [{ label: "Cost (USD)", data: DATA.by_model.map(m => m.cost_usd), backgroundColor: "rgba(106,163,255,.6)" }] },
      options: { responsive: true, indexAxis: "y", plugins: { legend: { display: false } } },
    });
  } else { document.getElementById("modelEmpty").innerHTML = '<div class="empty">No data yet.</div>'; }
}

renderCards(); renderUsers(); drawCharts();
setTimeout(() => location.reload(), 30000);
</script>
</body>
</html>"""
