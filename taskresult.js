function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// outcome: { accepted, title, message, task?: {name, location}, next }
// Deliberately identical for crewmates and impostors - nothing here may reveal the role.
function renderTaskResultHtml(outcome) {
    const ok = !!outcome.accepted;
    const color = ok ? '#10b981' : '#ef4444';
    const icon = ok ? '&#10003;' : '&#10005;';
    const next = outcome.next || '/dashboard';
    const taskBlock = outcome.task
        ? `<div class="task"><div class="task-name">${escapeHtml(outcome.task.name)}</div><div class="task-loc">${escapeHtml(outcome.task.location)}</div></div>`
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>${ok ? 'Task accepted' : 'Task declined'}</title>
<style>
  html, body { margin:0; height:100%; background:#0b1017; color:#e2e8f0;
    font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .wrap { min-height:100%; display:flex; align-items:center; justify-content:center; padding:20px; box-sizing:border-box; }
  .card { width:100%; max-width:380px; text-align:center; background:#10161d; border:1px solid ${color};
    border-radius:18px; padding:28px 20px; box-shadow:0 0 24px ${color}44; }
  .icon { width:72px; height:72px; line-height:72px; border-radius:50%; margin:0 auto 14px; font-size:2.2rem;
    color:${color}; border:2px solid ${color}; }
  h1 { margin:0 0 8px; font-size:1.3rem; letter-spacing:1px; text-transform:uppercase; color:${color}; }
  p { margin:0 0 16px; color:#94a3b8; font-size:0.95rem; }
  .task { margin:0 0 18px; padding:10px; border-radius:10px; background:rgba(255,255,255,0.04); border:1px solid #1e293b; }
  .task-name { font-weight:700; }
  .task-loc { color:#5eead4; font-size:0.85rem; margin-top:2px; }
  a.btn { display:block; padding:12px; border-radius:12px; text-decoration:none; font-weight:700;
    color:#e2e8f0; background:#1e293b; border:1px solid #334155; }
  .hint { margin-top:10px; font-size:0.75rem; color:#64748b; }
</style>
</head>
<body>
<div class="wrap"><div class="card">
  <div class="icon">${icon}</div>
  <h1>${escapeHtml(outcome.title)}</h1>
  <p>${escapeHtml(outcome.message)}</p>
  ${taskBlock}
  <a class="btn" href="${escapeHtml(next)}">Back to tablet</a>
  <div class="hint">Returning automatically...</div>
</div></div>
<script>setTimeout(function(){ window.location.href = ${JSON.stringify(next)}; }, 4000);</script>
</body>
</html>`;
}

// Shown on GET /task/:token. Same for everyone: it never reveals role or assignment.
function renderTaskConfirmHtml(task, token) {
    const action = '/task/' + encodeURIComponent(token);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Confirm task</title>
<style>
  html, body { margin:0; height:100%; background:#0b1017; color:#e2e8f0;
    font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .wrap { min-height:100%; display:flex; align-items:center; justify-content:center; padding:20px; box-sizing:border-box; }
  .card { width:100%; max-width:380px; text-align:center; background:#10161d; border:1px solid #5eead4;
    border-radius:18px; padding:28px 20px; box-shadow:0 0 24px #5eead444; }
  h1 { margin:0 0 8px; font-size:1.3rem; letter-spacing:1px; text-transform:uppercase; color:#5eead4; }
  p { margin:0 0 16px; color:#94a3b8; font-size:0.95rem; }
  .task { margin:0 0 18px; padding:10px; border-radius:10px; background:rgba(255,255,255,0.04); border:1px solid #1e293b; }
  .task-name { font-weight:700; }
  .task-loc { color:#5eead4; font-size:0.85rem; margin-top:2px; }
  button, a.btn { display:block; width:100%; box-sizing:border-box; padding:12px; border-radius:12px; text-decoration:none;
    font-weight:700; font-size:1rem; cursor:pointer; text-align:center; }
  button { color:#06201a; background:#5eead4; border:none; margin-bottom:10px; }
  a.btn { color:#e2e8f0; background:#1e293b; border:1px solid #334155; }
</style>
</head>
<body>
<div class="wrap"><div class="card">
  <h1>Complete task?</h1>
  <p>Only confirm once you have actually done it.</p>
  <div class="task"><div class="task-name">${escapeHtml(task.name)}</div><div class="task-loc">${escapeHtml(task.location)}</div></div>
  <form method="POST" action="${escapeHtml(action)}"><button type="submit">Complete task</button></form>
  <a class="btn" href="/dashboard">Cancel</a>
</div></div>
</body>
</html>`;
}

export { renderTaskResultHtml, renderTaskConfirmHtml };
