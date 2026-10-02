import type { ActivityFilters, RecentEventRow, Rule, RuleAnalyticsRow } from "./types";

export function renderLoginPage(invalid: boolean): string {
  return layout("Login", `
    <main class="login-shell">
      <section class="login-panel">
        <p class="eyebrow">Instagram Auto-DM</p>
        <h1>Admin Login</h1>
        ${invalid ? '<p class="alert">That token did not match.</p>' : ''}
        <form method="post" action="/admin/login" class="stack">
          <label>
            <span>Admin token</span>
            <input name="token" type="password" autocomplete="current-password" autofocus required>
          </label>
          <button type="submit">Open Dashboard</button>
        </form>
      </section>
    </main>
  `);
}

export function renderMissingAdminTokenPage(): string {
  return layout("Admin Token Missing", `
    <main class="login-shell">
      <section class="login-panel">
        <p class="eyebrow">Setup Needed</p>
        <h1>Set ADMIN_TOKEN</h1>
        <p class="muted">Create an admin token before using the dashboard.</p>
        <pre>npx wrangler secret put ADMIN_TOKEN</pre>
      </section>
    </main>
  `);
}

export function renderErrorPage(message: string): string {
  return layout("Error", `
    <main class="login-shell">
      <section class="login-panel">
        <p class="eyebrow">Could Not Save</p>
        <h1>${escapeHtml(message)}</h1>
        <p><a href="/admin">Back to dashboard</a></p>
      </section>
    </main>
  `);
}

export function renderDashboardPage(data: {
  dryRun: boolean;
  rules: Rule[];
  recentEvents: RecentEventRow[];
  ruleAnalytics: RuleAnalyticsRow[];
  filters: ActivityFilters;
  flash: string | null;
}): string {
  const activeRules = data.rules.filter((rule) => rule.active).length;
  const totalReceived = data.ruleAnalytics.reduce((sum, row) => sum + row.comments_received, 0);
  const sentCount = data.ruleAnalytics.reduce((sum, row) => sum + row.dm_sent_count, 0);
  const errorCount = data.ruleAnalytics.reduce((sum, row) => sum + row.error_count, 0);

  return layout("Instagram DM Rules", `
    <header class="topbar">
      <div class="brand-lockup">
        <div class="mark">DM</div>
        <div>
          <p class="eyebrow">Instagram Auto-DM</p>
          <h1>Comment Rules</h1>
        </div>
      </div>
      <div class="top-actions">
        <span class="status ${data.dryRun ? "status-warn" : "status-live"}">${data.dryRun ? "Dry run" : "Live sends"}</span>
        <form method="post" action="/admin/logout">
          <button class="secondary" type="submit">Log Out</button>
        </form>
      </div>
    </header>
    <main class="dashboard">
      ${data.flash ? `<p class="flash">${escapeHtml(data.flash)}</p>` : ""}
      <section class="status-bar" aria-label="Overview">
        ${renderStatusItem("Mode", data.dryRun ? "Dry run" : "Live")}
        ${renderStatusItem("Active rules", String(activeRules))}
        ${renderStatusItem("DM sent", String(sentCount))}
        ${renderStatusItem("Errors", String(errorCount))}
      </section>
      <section class="analytics-panel">
        <div class="section-head">
          <div>
            <h2>Analytics</h2>
          </div>
          <span class="subtle-count">${totalReceived} comments</span>
        </div>
        ${renderRuleAnalytics(data.ruleAnalytics)}
      </section>
      <section class="workspace">
        <aside class="compose-panel">
          <div class="section-head">
            <div>
              <h2>New Rule</h2>
            </div>
          </div>
          <form method="post" action="/admin/rules" class="rule-form">
            <label>
              <span>Tag</span>
              <input name="label" placeholder="Lead magnet" required>
            </label>
            <label>
              <span>Terms</span>
              <textarea name="keywords" rows="3" placeholder="GUIDE, checklist, webinar" required></textarea>
            </label>
            <label>
              <span>Message</span>
              <textarea name="reply_text" rows="5" placeholder="Thanks for commenting. Here is the link: https://..." required></textarea>
            </label>
            <label>
              <span>Public replies</span>
              <textarea name="public_reply_text" rows="3" placeholder="Sent it to you.&#10;Check your DMs!"></textarea>
              <span class="field-help">Optional. One reply per line; each comment gets one of them.</span>
            </label>
            <label>
              <span>Button link</span>
              <input name="link_url" type="url" placeholder="https://example.com">
            </label>
            <label>
              <span>Button label</span>
              <input name="link_button_label" maxlength="20" placeholder="Read now">
            </label>
            <div class="form-footer">
              <label class="check">
                <input name="active" type="checkbox" checked>
                <span>Active</span>
              </label>
              <button type="submit">Create</button>
            </div>
          </form>
        </aside>
        <div class="rules-panel">
          <div class="section-head">
            <div>
              <h2>Rules</h2>
            </div>
            <span class="subtle-count">${data.rules.length} total</span>
          </div>
          <div class="rules-list">
            ${data.rules.length === 0 ? '<p class="empty">No rules yet.</p>' : data.rules.map(renderRule).join("")}
          </div>
        </div>
      </section>
      <section class="activity-panel">
        <div class="section-head">
          <div>
            <h2>Activity</h2>
          </div>
          <span class="subtle-count">latest 50</span>
        </div>
        ${renderActivityFilters(data.filters)}
        ${renderRecentEvents(data.recentEvents, data.dryRun)}
      </section>
    </main>
  `);
}

function renderStatusItem(label: string, value: string): string {
  return `
    <div class="status-item">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderRuleAnalytics(rows: RuleAnalyticsRow[]): string {
  if (rows.length === 0) {
    return '<p class="empty">No rules to report yet.</p>';
  }

  return `
    <div class="table-wrap">
      <table class="analytics-table">
        <thead>
          <tr>
            <th>Rule</th>
            <th>Comments</th>
            <th>Matched</th>
            <th>DM sent</th>
            <th>Errors</th>
            <th>Last sent</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <td>${escapeHtml(row.rule_label)}</td>
              <td>${row.comments_received}</td>
              <td>${row.matched_count}</td>
              <td>${row.dm_sent_count}</td>
              <td>${row.error_count}</td>
              <td>${escapeHtml(row.last_sent_at ? formatTime(row.last_sent_at) : "Never")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderActivityFilters(filters: ActivityFilters): string {
  return `
    <form class="activity-filters" method="get" action="/admin">
      <label>
        <span>Status</span>
        <select name="status">
          ${renderStatusOption("", "All", filters.status)}
          ${renderStatusOption("sent", "Sent", filters.status)}
          ${renderStatusOption("send_error", "Send error", filters.status)}
          ${renderStatusOption("sent_public_reply_error", "Public reply failed", filters.status)}
          ${renderStatusOption("dry_run_matched", "Test match", filters.status)}
          ${renderStatusOption("ignored_no_keyword", "No keyword", filters.status)}
          ${renderStatusOption("ignored_owner", "Your comment", filters.status)}
          ${renderStatusOption("error", "Any error", filters.status)}
        </select>
      </label>
      <label>
        <span>Keyword</span>
        <input name="keyword" value="${escapeAttribute(filters.keyword)}" placeholder="GUIDE">
      </label>
      <label>
        <span>Date</span>
        <input name="date" type="date" value="${escapeAttribute(filters.date)}">
      </label>
      <label>
        <span>Username</span>
        <input name="username" value="${escapeAttribute(filters.username)}" placeholder="creatorhandle">
      </label>
      <div class="filter-actions">
        <button type="submit">Filter</button>
        <a class="secondary-link" href="/admin">Clear</a>
      </div>
    </form>
  `;
}

function renderStatusOption(value: string, label: string, selected: string): string {
  return `<option value="${escapeAttribute(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
}

function renderRule(rule: Rule): string {
  const keywords = rule.keywords.join(", ");
  const keywordChips = rule.keywords.map((keyword) => `<span class="chip">${escapeHtml(keyword)}</span>`).join("");
  const preview = truncate(rule.replyText, 142);
  return `
    <details class="rule ${rule.active ? "" : "inactive"}">
      <summary class="rule-summary">
        <div class="rule-summary-main">
          <div class="rule-title-row">
            <strong>${escapeHtml(rule.label)}</strong>
            <span class="status ${rule.active ? "status-live" : "status-off"}">${rule.active ? "Active" : "Off"}</span>
          </div>
          <div class="chips">${keywordChips}</div>
          <p class="reply-preview">${escapeHtml(preview)}</p>
        </div>
        <span class="edit-label">Edit</span>
      </summary>
      <form method="post" action="/admin/rules/${rule.id}" class="rule-edit">
        <label>
          <span>Tag</span>
          <input name="label" value="${escapeAttribute(rule.label)}" required>
        </label>
        <label class="span-2">
          <span>Terms</span>
          <textarea name="keywords" rows="2" required>${escapeHtml(keywords)}</textarea>
        </label>
        <label class="span-2">
          <span>Message</span>
          <textarea name="reply_text" rows="3" required>${escapeHtml(rule.replyText)}</textarea>
        </label>
        <label class="span-2">
          <span>Public replies</span>
          <textarea name="public_reply_text" rows="3">${escapeHtml(rule.publicReplyText ?? "")}</textarea>
          <span class="field-help">Optional. One reply per line; each comment gets one of them.</span>
        </label>
        <label>
          <span>Button link</span>
          <input name="link_url" type="url" value="${escapeAttribute(rule.linkUrl ?? "")}">
        </label>
        <label>
          <span>Button label</span>
          <input name="link_button_label" maxlength="20" value="${escapeAttribute(rule.linkButtonLabel ?? "")}">
        </label>
        <div class="rule-actions span-2">
          <label class="check">
            <input name="active" type="checkbox" ${rule.active ? "checked" : ""}>
            <span>Active</span>
          </label>
          <div class="button-row">
            <button name="action" value="save" type="submit">Save</button>
            <button class="secondary" name="action" value="toggle" type="submit">${rule.active ? "Turn Off" : "Turn On"}</button>
            <button class="danger" name="action" value="delete" type="submit" onclick="return confirm('Delete this rule?')">Delete</button>
          </div>
        </div>
      </form>
    </details>
  `;
}

function renderRecentEvents(events: RecentEventRow[], dryRun: boolean): string {
  if (events.length === 0) {
    return '<p class="empty">No comments match these filters.</p>';
  }

  return `
    <div class="activity-list">
      ${events.map((event) => `
        <article class="activity-item">
          <div class="activity-top">
            <div>
              <strong>${escapeHtml(event.username ? `@${event.username}` : "Unknown user")}</strong>
              <span>${escapeHtml(formatTime(event.received_at))}</span>
            </div>
            <span class="pill ${statusClass(event.status)}">${escapeHtml(formatStatus(event.status))}</span>
          </div>
          <p>${escapeHtml(event.comment_text)}</p>
          <div class="activity-meta">
            <span>${escapeHtml(event.rule_label ?? "No matched rule")}</span>
            ${event.matched_keyword ? `<span>Keyword: ${escapeHtml(event.matched_keyword)}</span>` : ""}
          </div>
          ${event.error ? `<small>${escapeHtml(event.error)}</small>` : ""}
          ${!dryRun && isRetryableStatus(event.status) ? `
            <form class="retry-form" method="post" action="/admin/events/${encodeURIComponent(event.comment_id)}/retry">
              <button class="secondary compact" type="submit">${event.status === "sent_public_reply_error" ? "Retry Public Reply" : "Retry Send"}</button>
            </form>
          ` : ""}
        </article>
      `).join("")}
    </div>
  `;
}

function isRetryableStatus(status: string): boolean {
  return status === "send_error" || status === "sent_public_reply_error";
}

function statusClass(status: string): string {
  if (status === "sent") {
    return "pill-good";
  }
  if (status === "sent_public_reply_error") {
    return "pill-warn";
  }
  if (status === "send_error") {
    return "pill-bad";
  }
  if (status.startsWith("ignored")) {
    return "pill-muted";
  }
  return "pill-neutral";
}

const STATUS_LABELS: Record<string, string> = {
  received: "Received",
  sent: "Sent",
  sent_public_reply_error: "Public reply failed",
  send_error: "Send failed",
  retrying: "Retrying",
  dry_run_matched: "Test match",
  ignored_no_keyword: "No keyword",
  ignored_owner: "Your comment"
};

function formatStatus(status: string): string {
  return STATUS_LABELS[status] ?? status.replace(/_/g, " ");
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --panel: #ffffff;
      --panel-subtle: #fbfcfd;
      --text: #111827;
      --muted: #667085;
      --line: #d9dee7;
      --soft-line: #edf0f4;
      --accent: #2563eb;
      --accent-dark: #1d4ed8;
      --accent-soft: #dbeafe;
      --good: #067647;
      --good-soft: #dcfae6;
      --danger: #b42318;
      --danger-soft: #fee4e2;
      --warn: #b54708;
      --warn-soft: #fef0c7;
      --off: #667085;
      --shadow: 0 12px 28px rgba(16, 24, 40, 0.06);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background:
        linear-gradient(180deg, #ffffff 0, var(--bg) 260px),
        var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45;
    }
    a { color: var(--accent-dark); }
    h1, h2, p { margin-top: 0; }
    h1 {
      margin-bottom: 0;
      font-size: 24px;
      font-weight: 760;
      letter-spacing: 0;
    }
    h2 {
      font-size: 16px;
      margin-bottom: 0;
      font-weight: 760;
      letter-spacing: 0;
    }
    label span {
      display: block;
      margin-bottom: 6px;
      color: #344054;
      font-size: 13px;
      font-weight: 680;
    }
    label .field-help, .field-help {
      display: block;
      margin: 6px 0 0;
      color: var(--muted);
      font-size: 12px;
      font-weight: 500;
    }
    input, textarea, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 11px 12px;
      color: var(--text);
      font: inherit;
      background: #fff;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    input:focus, textarea:focus, select:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
    }
    textarea { resize: vertical; }
    select {
      min-height: 42px;
      appearance: none;
    }
    button {
      border: 0;
      border-radius: 7px;
      padding: 10px 14px;
      background: var(--accent);
      color: #fff;
      font-weight: 720;
      cursor: pointer;
      min-height: 40px;
      transition: background 0.15s ease, transform 0.15s ease;
    }
    button:hover { background: var(--accent-dark); }
    button:active { transform: translateY(1px); }
    button.secondary {
      background: #f2f4f7;
      color: #344054;
    }
    button.secondary:hover { background: #e4e7ec; }
    button.compact {
      min-height: 34px;
      padding: 7px 10px;
      font-size: 12px;
    }
    button.danger {
      background: var(--danger-soft);
      color: var(--danger);
    }
    button.danger:hover { background: #fecdca; }
    pre {
      overflow: auto;
      border-radius: 8px;
      padding: 12px;
      background: #101828;
      color: #fff;
    }
    small {
      display: block;
      max-width: 320px;
      margin-top: 4px;
      color: var(--danger);
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      width: min(1180px, calc(100% - 32px));
      margin: 0 auto;
      padding: 28px 0 18px;
      background: transparent;
      border-bottom: 1px solid var(--line);
    }
    .brand-lockup {
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 0;
    }
    .mark {
      display: grid;
      place-items: center;
      flex: 0 0 auto;
      width: 42px;
      height: 42px;
      border-radius: 10px;
      background: var(--accent-soft);
      color: var(--accent-dark);
      font-size: 13px;
      font-weight: 900;
    }
    .top-actions {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .account-switcher {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      min-height: 40px;
      padding: 3px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.72);
    }
    .account-current, .account-link {
      display: inline-flex;
      align-items: center;
      min-height: 32px;
      padding: 0 11px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 720;
      text-decoration: none;
      white-space: nowrap;
    }
    .account-current {
      background: var(--accent);
      color: #fff;
    }
    .account-link {
      color: #344054;
      transition: background 0.15s ease, color 0.15s ease;
    }
    .account-link:hover {
      background: #f2f4f7;
      color: var(--accent-dark);
    }
    .dashboard {
      width: min(1180px, calc(100% - 32px));
      margin: 18px auto 48px;
      display: grid;
      gap: 18px;
      animation: enter 360ms ease-out both;
    }
    .status-bar {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.78);
      overflow: hidden;
    }
    .status-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      min-height: 58px;
      padding: 12px 16px;
      border-right: 1px solid var(--soft-line);
    }
    .status-item:last-child { border-right: 0; }
    .status-item span {
      color: var(--muted);
      font-size: 13px;
      font-weight: 680;
    }
    .status-item strong {
      font-size: 18px;
      font-weight: 760;
      text-align: right;
    }
    .workspace {
      display: grid;
      grid-template-columns: 340px minmax(0, 1fr);
      align-items: start;
      min-height: 520px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--panel);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .login-panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 20px;
      box-shadow: var(--shadow);
    }
    .compose-panel {
      position: sticky;
      top: 18px;
      align-self: start;
      min-height: 520px;
      padding: 22px;
      border-right: 1px solid var(--line);
      background: var(--panel-subtle);
    }
    .rules-panel {
      padding: 22px;
    }
    .analytics-panel,
    .activity-panel {
      border-top: 1px solid var(--line);
      padding-top: 18px;
    }
    .analytics-panel {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--panel);
      box-shadow: var(--shadow);
      padding: 18px;
    }
    .section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 18px;
    }
    .login-shell {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .login-panel { width: min(420px, 100%); }
    .stack, .rule-form, .rule-edit {
      display: grid;
      gap: 14px;
    }
    .rule-form { gap: 16px; }
    .form-footer, .rule-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .subtle-count {
      color: var(--muted);
      font-size: 13px;
      font-weight: 680;
    }
    .rules-list {
      display: grid;
      border-top: 1px solid var(--soft-line);
    }
    .rule {
      border-bottom: 1px solid var(--soft-line);
      background: transparent;
      overflow: hidden;
      transition: background 160ms ease;
    }
    .rule:hover { background: #fbfdff; }
    .rule.inactive { opacity: 0.72; }
    .rule-summary {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 14px;
      padding: 18px 0;
      cursor: pointer;
      list-style: none;
    }
    .rule-summary::-webkit-details-marker { display: none; }
    .rule-title-row, .button-row {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .rule-title-row { margin-bottom: 8px; }
    .rule-summary-main { min-width: 0; }
    .reply-preview {
      margin: 10px 0 0;
      color: #475467;
      font-size: 13px;
      line-height: 1.45;
    }
    .edit-label {
      color: var(--muted);
      font-size: 13px;
      font-weight: 760;
      white-space: nowrap;
    }
    .rule-edit {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      padding: 16px 0 20px;
      border-top: 1px solid var(--soft-line);
      animation: reveal 180ms ease-out both;
    }
    .span-2 { grid-column: 1 / -1; }
    .button-row { justify-content: flex-start; }
    .chips {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 3px 8px;
      border-radius: 999px;
      background: #eef4ff;
      color: #3538cd;
      font-size: 12px;
      font-weight: 720;
    }
    .check {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 40px;
    }
    .check input {
      width: 18px;
      height: 18px;
    }
    .check span { margin: 0; }
    .status, .pill {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 4px 9px;
      font-size: 12px;
      font-weight: 720;
      white-space: nowrap;
    }
    .status-live { background: var(--good-soft); color: var(--good); }
    .status-warn { background: var(--warn-soft); color: var(--warn); }
    .status-off { background: #f2f4f7; color: var(--off); }
    .pill-neutral { background: #f2f4f7; color: #344054; }
    .pill-good { background: var(--good-soft); color: var(--good); }
    .pill-warn { background: var(--warn-soft); color: var(--warn); }
    .pill-bad { background: var(--danger-soft); color: var(--danger); }
    .pill-muted { background: #f8fafc; color: #667085; }
    .eyebrow {
      margin-bottom: 6px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 760;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    .muted { color: var(--muted); }
    .empty {
      margin: 0;
      padding: 30px 0;
      border: 1px dashed var(--line);
      border-radius: 10px;
      color: var(--muted);
      text-align: center;
    }
    .alert, .flash {
      border-radius: 10px;
      padding: 10px 12px;
      font-weight: 680;
    }
    .alert { background: var(--danger-soft); color: var(--danger); }
    .flash { background: var(--good-soft); color: var(--good); }
    .activity-list {
      display: grid;
      border-top: 1px solid var(--soft-line);
    }
    .table-wrap {
      overflow-x: auto;
      border: 1px solid var(--soft-line);
      border-radius: 10px;
    }
    .analytics-table {
      width: 100%;
      min-width: 720px;
      border-collapse: collapse;
      font-size: 13px;
    }
    .analytics-table th,
    .analytics-table td {
      padding: 11px 12px;
      border-bottom: 1px solid var(--soft-line);
      text-align: left;
      white-space: nowrap;
    }
    .analytics-table th {
      background: var(--panel-subtle);
      color: var(--muted);
      font-weight: 760;
    }
    .analytics-table tr:last-child td { border-bottom: 0; }
    .activity-filters {
      display: grid;
      grid-template-columns: 150px minmax(0, 1fr) 170px minmax(0, 1fr) auto;
      gap: 12px;
      align-items: end;
      margin-bottom: 14px;
      padding: 14px;
      border: 1px solid var(--soft-line);
      border-radius: 10px;
      background: var(--panel-subtle);
    }
    .filter-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 42px;
    }
    .secondary-link {
      color: var(--muted);
      font-size: 13px;
      font-weight: 720;
      text-decoration: none;
    }
    .activity-item {
      padding: 14px 0;
      border-bottom: 1px solid var(--soft-line);
      transition: transform 160ms ease, background 160ms ease;
    }
    .activity-item:hover { transform: translateX(2px); }
    .activity-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .activity-top strong {
      display: block;
      font-size: 14px;
    }
    .activity-top span {
      color: var(--muted);
      font-size: 12px;
    }
    .activity-item p {
      margin: 10px 0;
      color: #344054;
      font-size: 14px;
    }
    .activity-meta {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .activity-meta span {
      border-radius: 999px;
      padding: 3px 8px;
      background: var(--panel-subtle);
      border: 1px solid var(--soft-line);
      color: var(--muted);
      font-size: 12px;
      font-weight: 680;
    }
    .retry-form { margin-top: 10px; }
    @keyframes enter {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes reveal {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @media (max-width: 880px) {
      .topbar { align-items: flex-start; flex-direction: column; }
      .top-actions { justify-content: flex-start; }
      .workspace, .status-bar { grid-template-columns: 1fr; }
      .activity-filters { grid-template-columns: 1fr; }
      .status-item {
        border-right: 0;
        border-bottom: 1px solid var(--soft-line);
      }
      .status-item:last-child { border-bottom: 0; }
      .compose-panel { position: static; }
      .compose-panel {
        min-height: 0;
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .rule-edit { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}
