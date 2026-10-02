import { renderDashboardPage, renderErrorPage, renderLoginPage, renderMissingAdminTokenPage } from "./dashboard";
import type { ActivityFilters, RecentEventRow, Rule, RuleAnalyticsRow } from "./types";

type SecretEnv = {
  WEBHOOK_VERIFY_TOKEN: string;
  META_APP_SECRET?: string;
  INSTAGRAM_APP_SECRET?: string;
  INSTAGRAM_ACCESS_TOKEN: string;
  IG_USER_ID: string;
  ADMIN_TOKEN?: string;
  OWNER_IG_USERNAME?: string;
};

type AppEnv = Cloudflare.Env & SecretEnv;

type InstagramWebhookPayload = {
  object?: string;
  entry?: Array<{
    id?: string;
    time?: number;
    changes?: Array<{
      field?: string;
      value?: Record<string, unknown>;
    }>;
  }>;
};

type CommentEvent = {
  commentId: string;
  mediaId: string | null;
  authorId: string | null;
  username: string | null;
  text: string;
};

type RuleRow = {
  id: number;
  label: string;
  keywords: string;
  reply_text: string;
  public_reply_text: string | null;
  link_url: string | null;
  link_button_label: string | null;
  active: number;
  created_at: string;
  updated_at: string;
};

type MatchedRule = Rule & {
  matchedKeyword: string;
};

type RetryEventRow = {
  comment_id: string;
  matched_rule_id: number | null;
  matched_keyword: string | null;
  rule_label: string | null;
  status: string;
  sent_at: string | null;
  meta_response: string | null;
};

type SendRuleResult = {
  status: string;
  metaResponse: unknown;
  error: string | null;
  sentAt: string;
};

const ADMIN_COOKIE_NAME = "ig_dm_admin";
const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const DEFAULT_GRAPH_API_BASE = "https://graph.instagram.com/v25.0";
const FALLBACK_RULE_ID = 0;
// Instagram limits: text DMs 1,000 characters, button-template text 640, comments 2,200.
const MAX_TEXT_MESSAGE_LENGTH = 1000;
const MAX_BUTTON_TEXT_LENGTH = 640;
const MAX_PUBLIC_REPLY_LENGTH = 2200;
const MAX_PUBLIC_REPLY_TOTAL = 10000;

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Dashboard forms post to their own origin. Reject cross-site form submissions.
    if (request.method === "POST" && url.pathname.startsWith("/admin/")) {
      const origin = request.headers.get("origin");
      if ((origin && origin !== url.origin) || request.headers.get("sec-fetch-site") === "cross-site") {
        return html(renderErrorPage("Admin changes must come from this dashboard."), 403);
      }
    }

    if (request.method === "GET" && url.pathname === "/") {
      return json({ ok: true, service: "manychat-lite-cloudflare", admin: "/admin" });
    }

    if (request.method === "GET" && url.pathname === "/admin") {
      return handleAdminGet(request, env, url);
    }

    if (request.method === "POST" && url.pathname === "/admin/login") {
      return handleAdminLogin(request, env);
    }

    if (request.method === "POST" && url.pathname === "/admin/logout") {
      return handleAdminLogout();
    }

    if (request.method === "POST" && url.pathname === "/admin/rules") {
      return handleCreateRule(request, env);
    }

    const ruleMatch = url.pathname.match(/^\/admin\/rules\/(\d+)$/);
    if (request.method === "POST" && ruleMatch) {
      return handleUpdateRule(request, env, Number(ruleMatch[1]));
    }

    const retryMatch = url.pathname.match(/^\/admin\/events\/([^/]+)\/retry$/);
    if (request.method === "POST" && retryMatch) {
      return handleRetryEvent(request, env, decodeURIComponent(retryMatch[1]));
    }

    if (request.method === "GET" && url.pathname === "/webhook") {
      return verifyWebhook(url, env);
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhookPost(request, env, ctx);
    }

    return json({ ok: false, error: "Not found" }, 404);
  }
};

async function handleWebhookPost(
  request: Request,
  env: AppEnv,
  ctx: ExecutionContext
): Promise<Response> {
  const rawBody = await request.arrayBuffer();
  const signature = request.headers.get("x-hub-signature-256");
  const appSecret = env.INSTAGRAM_APP_SECRET ?? env.META_APP_SECRET ?? "";

  if (!(await isValidMetaSignature(rawBody, signature, appSecret))) {
    console.warn(JSON.stringify({
      level: "warn",
      msg: "invalid_webhook_signature",
      hasSignature: Boolean(signature),
      hasAppSecret: Boolean(appSecret)
    }));
    return json({ ok: false, error: "Invalid webhook signature" }, 401);
  }

  const payload = parseJsonBody(rawBody);
  const events = extractCommentEvents(payload);

  for (const event of events) {
    ctx.waitUntil(processCommentEvent(event, env));
  }

  return json({ ok: true, queued: events.length });
}

function verifyWebhook(url: URL, env: AppEnv): Response {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === env.WEBHOOK_VERIFY_TOKEN && challenge) {
    return new Response(challenge, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }

  return json({ ok: false, error: "Webhook verification failed" }, 403);
}

async function processCommentEvent(event: CommentEvent, env: AppEnv): Promise<void> {
  const receivedAt = new Date().toISOString();
  const inserted = await insertCommentEvent(env.DB, event, receivedAt);

  if (!inserted) {
    console.log(JSON.stringify({ level: "info", msg: "duplicate_comment", commentId: event.commentId }));
    return;
  }

  if (isOwnerComment(event, env)) {
    await updateStatus(env.DB, event.commentId, "ignored_owner", false, null);
    return;
  }

  const rule = await findMatchingRule(env.DB, event.text, env);
  if (!rule) {
    await updateStatus(env.DB, event.commentId, "ignored_no_keyword", false, null);
    return;
  }

  if (isDryRun(env)) {
    await updateStatus(env.DB, event.commentId, "dry_run_matched", true, rule);
    console.log(JSON.stringify({ level: "info", msg: "dry_run_private_reply", event, rule: summarizeRule(rule) }));
    return;
  }

  try {
    const result = await sendRuleResponses(env, event.commentId, rule);
    await updateEventAfterSend(env.DB, event.commentId, rule, result);
  } catch (error) {
    await recordCommentSendError(env.DB, event.commentId, rule, error);
  }
}

function isDryRun(env: AppEnv): boolean {
  return String(env.DRY_RUN ?? "true").toLowerCase() !== "false";
}

async function recordCommentSendError(
  db: D1Database,
  commentId: string,
  rule: MatchedRule,
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db.prepare(
    `UPDATE comment_events
     SET matched = 1,
         status = 'send_error',
         error = ?,
         matched_rule_id = ?,
         matched_keyword = ?,
         rule_label = ?
     WHERE comment_id = ?`
  )
    .bind(message, rule.id, rule.matchedKeyword, rule.label, commentId)
    .run();
  console.error(JSON.stringify({ level: "error", msg: "private_reply_failed", commentId, error: message }));
}

async function sendRuleResponses(
  env: AppEnv,
  commentId: string,
  rule: MatchedRule
): Promise<SendRuleResult> {
  const privateReply = await sendPrivateReply(
    env,
    commentId,
    rule.replyText,
    rule.linkUrl,
    rule.linkButtonLabel
  );
  return completeCommentResponses(env, commentId, privateReply, rule.publicReplyText);
}

// Sends the optional public reply after a successful private reply. A retry of a
// failed public reply calls this again with the stored private reply, so the DM
// is never sent twice.
async function completeCommentResponses(
  env: AppEnv,
  commentId: string,
  privateReply: unknown,
  publicReplyText: string | null,
  sentAt = new Date().toISOString()
): Promise<SendRuleResult> {
  let publicReply: unknown = null;
  let publicReplyError: string | null = null;

  const selectedText = publicReplyText ? selectRotatingText(publicReplyText, commentId) : null;
  if (selectedText) {
    try {
      publicReply = await sendPublicCommentReply(env, commentId, selectedText);
    } catch (error) {
      publicReplyError = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({
        level: "error",
        msg: "public_comment_reply_failed",
        commentId,
        error: publicReplyError
      }));
    }
  }

  return {
    status: publicReplyError ? "sent_public_reply_error" : "sent",
    metaResponse: { privateReply, publicReply, publicReplyError },
    error: publicReplyError,
    sentAt
  };
}

// Public reply text may hold several lines. One line is picked per comment, so
// replies vary across comments, while a retry of the same comment keeps its line.
function selectRotatingText(value: string, seed: string): string | null {
  const options = value
    .split(/\r?\n/)
    .map((option) => option.trim())
    .filter((option) => option.length > 0);

  if (options.length === 0) {
    return null;
  }

  return options[hashString(seed) % options.length];
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

async function updateEventAfterSend(
  db: D1Database,
  commentId: string,
  rule: MatchedRule,
  result: SendRuleResult
): Promise<void> {
  await db.prepare(
    `UPDATE comment_events
     SET matched = 1,
         status = ?,
         meta_response = ?,
         error = ?,
         matched_rule_id = ?,
         matched_keyword = ?,
         rule_label = ?,
         sent_at = ?
     WHERE comment_id = ?`
  )
    .bind(
      result.status,
      JSON.stringify(result.metaResponse),
      result.error,
      rule.id,
      rule.matchedKeyword,
      rule.label,
      result.sentAt,
      commentId
    )
    .run();
}

async function insertCommentEvent(
  db: D1Database,
  event: CommentEvent,
  receivedAt: string
): Promise<boolean> {
  const result = await db.prepare(
    `INSERT OR IGNORE INTO comment_events
      (comment_id, media_id, username, comment_text, status, received_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(event.commentId, event.mediaId, event.username, event.text, "received", receivedAt)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

async function updateStatus(
  db: D1Database,
  commentId: string,
  status: string,
  matched: boolean,
  rule: MatchedRule | null
): Promise<void> {
  await db.prepare(
    `UPDATE comment_events
     SET matched = ?,
         status = ?,
         matched_rule_id = ?,
         matched_keyword = ?,
         rule_label = ?
     WHERE comment_id = ?`
  )
    .bind(
      matched ? 1 : 0,
      status,
      rule?.id ?? null,
      rule?.matchedKeyword ?? null,
      rule?.label ?? null,
      commentId
    )
    .run();
}

async function findMatchingRule(db: D1Database, text: string, env: AppEnv): Promise<MatchedRule | null> {
  const activeRules = await getRules(db, true);

  for (const rule of activeRules) {
    const matchedKeyword = findMatchedKeyword(text, rule.keywords);
    if (matchedKeyword) {
      return { ...rule, matchedKeyword };
    }
  }

  const fallback = getFallbackRule(env);
  if (!fallback || !matchesKeyword(text, fallback.keywords[0])) {
    return null;
  }

  return { ...fallback, matchedKeyword: fallback.keywords[0] };
}

// The KEYWORD and PRIVATE_REPLY_TEXT vars in wrangler.jsonc act as one extra rule
// (id 0) that applies when no dashboard rule matches.
function getFallbackRule(env: AppEnv): Rule | null {
  const fallbackKeyword = env.KEYWORD?.trim();
  if (!fallbackKeyword) {
    return null;
  }

  return {
    id: FALLBACK_RULE_ID,
    label: "Fallback rule",
    keywords: [fallbackKeyword],
    replyText: env.PRIVATE_REPLY_TEXT ?? "Thanks for commenting.",
    publicReplyText: null,
    linkUrl: null,
    linkButtonLabel: null,
    active: true,
    createdAt: "",
    updatedAt: ""
  };
}

async function sendPrivateReply(
  env: AppEnv,
  commentId: string,
  message: string,
  linkUrl: string | null,
  linkButtonLabel: string | null
): Promise<unknown> {
  return postInstagramMessage(
    env,
    { comment_id: commentId },
    buildPrivateReplyMessage(message, linkUrl, linkButtonLabel)
  );
}

// Sends a private reply (recipient.comment_id) or a DM to someone who messaged
// the account (recipient.id).
async function postInstagramMessage(
  env: AppEnv,
  recipient: { comment_id: string } | { id: string },
  message: Record<string, unknown>
): Promise<unknown> {
  if (!env.IG_USER_ID) {
    throw new Error("Missing IG_USER_ID");
  }

  const base = (env.GRAPH_API_BASE ?? DEFAULT_GRAPH_API_BASE).replace(/\/$/, "");
  const response = await fetch(`${base}/${env.IG_USER_ID}/messages`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.INSTAGRAM_ACCESS_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ recipient, message })
  });

  const responseText = await response.text();
  const parsed = parseJsonText(responseText);

  if (!response.ok) {
    throw new Error(`Meta API ${response.status}: ${responseText}`);
  }

  return parsed ?? responseText;
}

async function sendPublicCommentReply(
  env: AppEnv,
  commentId: string,
  message: string
): Promise<unknown> {
  const base = (env.GRAPH_API_BASE ?? DEFAULT_GRAPH_API_BASE).replace(/\/$/, "");
  const endpoint = new URL(`${base}/${commentId}/replies`);
  endpoint.searchParams.set("message", message);

  const response = await fetch(endpoint.toString(), {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.INSTAGRAM_ACCESS_TOKEN}`
    }
  });
  const responseText = await response.text();
  const parsed = parseJsonText(responseText);

  if (!response.ok) {
    throw new Error(`Meta API ${response.status}: ${responseText}`);
  }

  return parsed ?? responseText;
}

function buildPrivateReplyMessage(
  text: string,
  linkUrl: string | null,
  linkButtonLabel: string | null
): Record<string, unknown> {
  if (!linkUrl || !linkButtonLabel) {
    return { text };
  }

  return {
    attachment: {
      type: "template",
      payload: {
        template_type: "button",
        text,
        buttons: [
          {
            type: "web_url",
            url: linkUrl,
            title: linkButtonLabel
          }
        ]
      }
    }
  };
}

async function handleAdminGet(request: Request, env: AppEnv, url: URL): Promise<Response> {
  if (!env.ADMIN_TOKEN) {
    return html(renderMissingAdminTokenPage(), 503);
  }

  if (!(await isAdminRequest(request, env))) {
    return html(renderLoginPage(url.searchParams.get("error") === "1"));
  }

  const filters = parseActivityFilters(url);
  const [rules, recentEvents, ruleAnalytics] = await Promise.all([
    getRules(env.DB, false),
    getRecentEvents(env.DB, filters),
    getRuleAnalytics(env.DB)
  ]);

  return html(renderDashboardPage({
    dryRun: isDryRun(env),
    rules,
    recentEvents,
    ruleAnalytics,
    filters,
    flash: url.searchParams.get("saved") === "1" ? "Saved." : null
  }));
}

async function handleAdminLogin(request: Request, env: AppEnv): Promise<Response> {
  if (!env.ADMIN_TOKEN) {
    return html(renderMissingAdminTokenPage(), 503);
  }

  const form = await request.formData();
  const token = getFormString(form, "token");

  if (!(await safeEqualText(token, env.ADMIN_TOKEN))) {
    return redirect("/admin?error=1");
  }

  const session = await createAdminSession(env);
  return redirect("/admin", {
    "set-cookie": buildCookie(ADMIN_COOKIE_NAME, session, ADMIN_SESSION_TTL_SECONDS)
  });
}

function handleAdminLogout(): Response {
  return redirect("/admin", {
    "set-cookie": `${ADMIN_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`
  });
}

async function handleCreateRule(request: Request, env: AppEnv): Promise<Response> {
  if (!(await isAdminRequest(request, env))) {
    return redirect("/admin");
  }

  const form = await request.formData();
  const parsed = parseRuleForm(form);
  if (!parsed.ok) {
    return html(renderErrorPage(parsed.error), 400);
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO rules
       (label, keywords, reply_text, public_reply_text, link_url, link_button_label, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      parsed.rule.label,
      JSON.stringify(parsed.rule.keywords),
      parsed.rule.replyText,
      parsed.rule.publicReplyText,
      parsed.rule.linkUrl,
      parsed.rule.linkButtonLabel,
      parsed.rule.active ? 1 : 0,
      now,
      now
    )
    .run();

  return redirect("/admin?saved=1");
}

async function handleUpdateRule(request: Request, env: AppEnv, ruleId: number): Promise<Response> {
  if (!(await isAdminRequest(request, env))) {
    return redirect("/admin");
  }

  const form = await request.formData();
  const action = getFormString(form, "action");

  if (action === "delete") {
    await env.DB.prepare("DELETE FROM rules WHERE id = ?").bind(ruleId).run();
    return redirect("/admin?saved=1");
  }

  if (action === "toggle") {
    await env.DB.prepare(
      "UPDATE rules SET active = CASE active WHEN 1 THEN 0 ELSE 1 END, updated_at = ? WHERE id = ?"
    )
      .bind(new Date().toISOString(), ruleId)
      .run();
    return redirect("/admin?saved=1");
  }

  const parsed = parseRuleForm(form);
  if (!parsed.ok) {
    return html(renderErrorPage(parsed.error), 400);
  }

  await env.DB.prepare(
    `UPDATE rules
     SET label = ?,
         keywords = ?,
         reply_text = ?,
         public_reply_text = ?,
         link_url = ?,
         link_button_label = ?,
         active = ?,
         updated_at = ?
     WHERE id = ?`
  )
    .bind(
      parsed.rule.label,
      JSON.stringify(parsed.rule.keywords),
      parsed.rule.replyText,
      parsed.rule.publicReplyText,
      parsed.rule.linkUrl,
      parsed.rule.linkButtonLabel,
      parsed.rule.active ? 1 : 0,
      new Date().toISOString(),
      ruleId
    )
    .run();

  return redirect("/admin?saved=1");
}

async function handleRetryEvent(request: Request, env: AppEnv, commentId: string): Promise<Response> {
  if (!(await isAdminRequest(request, env))) {
    return redirect("/admin");
  }

  if (isDryRun(env)) {
    return html(renderErrorPage("Sending is off in test mode. Set DRY_RUN to \"false\" before retrying."), 400);
  }

  const event = await getRetryEvent(env.DB, commentId);
  if (!event || !isRetryableStatus(event.status)) {
    return html(renderErrorPage("Only failed replies can be retried."), 400);
  }

  if (event.matched_rule_id === null) {
    return html(renderErrorPage("That comment does not have a matched rule to retry."), 400);
  }

  const rule = event.matched_rule_id === FALLBACK_RULE_ID
    ? getFallbackRule(env)
    : await getRuleById(env.DB, event.matched_rule_id);
  if (!rule) {
    return html(renderErrorPage("The matched rule no longer exists."), 400);
  }

  if (!rule.active) {
    return html(renderErrorPage("This rule is turned off. Turn it on before retrying."), 400);
  }

  const originalKeyword = event.matched_keyword?.trim().toLowerCase();
  if (originalKeyword && !rule.keywords.some((keyword) => keyword.trim().toLowerCase() === originalKeyword)) {
    return html(renderErrorPage("The keyword this comment matched was removed from the rule, so it cannot be retried with the changed rule."), 400);
  }

  const matchedRule: MatchedRule = {
    ...rule,
    matchedKeyword: event.matched_keyword ?? rule.keywords[0] ?? ""
  };

  // Claim the event before sending so two clicks cannot deliver two DMs.
  const claimed = await env.DB.prepare(
    "UPDATE comment_events SET status = 'retrying' WHERE comment_id = ? AND status = ?"
  )
    .bind(commentId, event.status)
    .run();
  if (!claimed.meta.changes) {
    return html(renderErrorPage("This reply is already being retried or has changed. Refresh the dashboard."), 409);
  }

  try {
    let result: SendRuleResult;
    if (event.status === "sent_public_reply_error") {
      // The DM was delivered. Only the public comment reply is sent again.
      const stored = event.meta_response ? parseJsonText(event.meta_response) : null;
      const privateReply = stored && typeof stored === "object"
        ? (stored as Record<string, unknown>).privateReply
        : null;
      result = await completeCommentResponses(
        env,
        commentId,
        privateReply,
        matchedRule.publicReplyText,
        event.sent_at ?? new Date().toISOString()
      );
    } else {
      result = await sendRuleResponses(env, commentId, matchedRule);
    }
    await updateEventAfterSend(env.DB, commentId, matchedRule, result);
  } catch (error) {
    if (event.status === "sent_public_reply_error") {
      // Keep a delivered DM marked as delivered.
      await env.DB.prepare("UPDATE comment_events SET status = 'sent_public_reply_error', error = ? WHERE comment_id = ?")
        .bind(error instanceof Error ? error.message : String(error), commentId)
        .run();
    } else {
      await recordCommentSendError(env.DB, commentId, matchedRule, error);
    }
  }

  return redirect("/admin?saved=1");
}

function isRetryableStatus(status: string): boolean {
  return status === "send_error" || status === "sent_public_reply_error";
}

async function getRules(db: D1Database, activeOnly: boolean): Promise<Rule[]> {
  const query = activeOnly
    ? `SELECT id, label, keywords, reply_text, public_reply_text, link_url, link_button_label, active, created_at, updated_at
       FROM rules WHERE active = 1 ORDER BY id ASC`
    : `SELECT id, label, keywords, reply_text, public_reply_text, link_url, link_button_label, active, created_at, updated_at
       FROM rules ORDER BY id ASC`;
  const result = await db.prepare(query).all<RuleRow>();
  return result.results.map(rowToRule);
}

async function getRuleById(db: D1Database, ruleId: number): Promise<Rule | null> {
  const row = await db.prepare(
    `SELECT id, label, keywords, reply_text, public_reply_text, link_url, link_button_label, active, created_at, updated_at
     FROM rules
     WHERE id = ?`
  )
    .bind(ruleId)
    .first<RuleRow>();

  return row ? rowToRule(row) : null;
}

async function getRetryEvent(db: D1Database, commentId: string): Promise<RetryEventRow | null> {
  return db.prepare(
    `SELECT comment_id, matched_rule_id, matched_keyword, rule_label, status, sent_at, meta_response
     FROM comment_events
     WHERE comment_id = ?`
  )
    .bind(commentId)
    .first<RetryEventRow>();
}

async function getRecentEvents(db: D1Database, filters: ActivityFilters): Promise<RecentEventRow[]> {
  const { where, bindings } = buildActivityWhere(filters);
  const result = await db.prepare(
    `SELECT comment_id, username, comment_text, status, rule_label, matched_keyword, error, received_at, sent_at
     FROM comment_events
     ${where}
     ORDER BY received_at DESC
     LIMIT 50`
  )
    .bind(...bindings)
    .all<RecentEventRow>();

  return result.results;
}

async function getRuleAnalytics(db: D1Database): Promise<RuleAnalyticsRow[]> {
  const result = await db.prepare(
    `SELECT
       r.id AS rule_id,
       r.label AS rule_label,
       COUNT(e.comment_id) AS comments_received,
       COALESCE(SUM(CASE WHEN e.matched = 1 THEN 1 ELSE 0 END), 0) AS matched_count,
       COALESCE(SUM(CASE WHEN e.status IN ('sent', 'sent_public_reply_error') THEN 1 ELSE 0 END), 0) AS dm_sent_count,
       COALESCE(SUM(CASE WHEN e.status IN ('send_error', 'sent_public_reply_error') OR e.error IS NOT NULL THEN 1 ELSE 0 END), 0) AS error_count,
       MAX(e.sent_at) AS last_sent_at
     FROM rules r
     LEFT JOIN comment_events e ON e.matched_rule_id = r.id
     GROUP BY r.id, r.label
     ORDER BY r.id ASC`
  ).all<RuleAnalyticsRow>();

  return result.results;
}

function parseActivityFilters(url: URL): ActivityFilters {
  return {
    status: normalizeFilter(url.searchParams.get("status")),
    keyword: normalizeFilter(url.searchParams.get("keyword")),
    username: normalizeFilter(url.searchParams.get("username")),
    date: normalizeFilter(url.searchParams.get("date"))
  };
}

function normalizeFilter(value: string | null): string {
  return value?.trim() ?? "";
}

function buildActivityWhere(filters: ActivityFilters): { where: string; bindings: Array<string> } {
  const clauses: string[] = [];
  const bindings: string[] = [];

  if (filters.status) {
    if (filters.status === "error") {
      clauses.push("(status IN ('send_error', 'sent_public_reply_error') OR error IS NOT NULL)");
    } else {
      clauses.push("status = ?");
      bindings.push(filters.status);
    }
  }

  if (filters.keyword) {
    clauses.push("(LOWER(COALESCE(matched_keyword, '')) LIKE ? OR LOWER(comment_text) LIKE ?)");
    const value = `%${filters.keyword.toLowerCase()}%`;
    bindings.push(value, value);
  }

  if (filters.username) {
    clauses.push("LOWER(COALESCE(username, '')) LIKE ?");
    bindings.push(`%${filters.username.toLowerCase().replace(/^@/, "")}%`);
  }

  if (filters.date && /^\d{4}-\d{2}-\d{2}$/.test(filters.date)) {
    const start = new Date(`${filters.date}T00:00:00.000Z`);
    // Ignore impossible dates such as 2026-02-31 instead of throwing.
    if (!Number.isNaN(start.getTime()) && start.toISOString().slice(0, 10) === filters.date) {
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 1);
      clauses.push("received_at >= ? AND received_at < ?");
      bindings.push(start.toISOString(), end.toISOString());
    }
  }

  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    bindings
  };
}

function rowToRule(row: RuleRow): Rule {
  return {
    id: row.id,
    label: row.label,
    keywords: parseStoredKeywords(row.keywords),
    replyText: row.reply_text,
    publicReplyText: row.public_reply_text,
    linkUrl: row.link_url,
    linkButtonLabel: row.link_button_label,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseRuleForm(form: FormData): { ok: true; rule: Omit<Rule, "id" | "createdAt" | "updatedAt"> } | { ok: false; error: string } {
  const label = getFormString(form, "label").trim();
  const keywords = parseKeywordsInput(getFormString(form, "keywords"));
  const replyText = getFormString(form, "reply_text").trim();
  const publicReplyText = nullableTrim(getFormString(form, "public_reply_text"));
  const linkUrl = nullableTrim(getFormString(form, "link_url"));
  const linkButtonLabel = nullableTrim(getFormString(form, "link_button_label"));
  const active = form.get("active") === "on";

  if (!label) {
    return { ok: false, error: "Rule label is required." };
  }

  if (keywords.length === 0) {
    return { ok: false, error: "Add at least one keyword." };
  }

  if (!replyText) {
    return { ok: false, error: "DM reply text is required." };
  }

  if ((linkUrl && !linkButtonLabel) || (!linkUrl && linkButtonLabel)) {
    return { ok: false, error: "Add both a button link and button label, or leave both blank." };
  }

  if (linkUrl && !isHttpsUrl(linkUrl)) {
    return { ok: false, error: "Button link must be a valid https URL." };
  }

  if (linkButtonLabel && linkButtonLabel.length > 20) {
    return { ok: false, error: "Button label must be 20 characters or fewer." };
  }

  const maxReplyLength = linkUrl ? MAX_BUTTON_TEXT_LENGTH : MAX_TEXT_MESSAGE_LENGTH;
  if (replyText.length > maxReplyLength) {
    return {
      ok: false,
      error: linkUrl
        ? "With a link button, the DM text must be 640 characters or fewer."
        : "DM text must be 1,000 characters or fewer."
    };
  }

  if (publicReplyText && (
    publicReplyText.length > MAX_PUBLIC_REPLY_TOTAL ||
    publicReplyText.split(/\r?\n/).some((line) => line.trim().length > MAX_PUBLIC_REPLY_LENGTH)
  )) {
    return { ok: false, error: "Each public reply must be 2,200 characters or fewer, with 10,000 characters in total." };
  }

  return { ok: true, rule: { label, keywords, replyText, publicReplyText, linkUrl, linkButtonLabel, active } };
}

function nullableTrim(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function parseKeywordsInput(input: string): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];

  for (const part of input.split(/[\n,]/)) {
    const keyword = part.trim();
    const key = keyword.toLowerCase();
    if (!keyword || seen.has(key)) {
      continue;
    }
    seen.add(key);
    keywords.push(keyword);
  }

  return keywords;
}

function parseStoredKeywords(value: string): string[] {
  const parsed = parseJsonText(value);
  if (Array.isArray(parsed)) {
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }
  return parseKeywordsInput(value);
}

function findMatchedKeyword(text: string, keywords: string[]): string | null {
  for (const keyword of keywords) {
    if (matchesKeyword(text, keyword)) {
      return keyword;
    }
  }
  return null;
}

function extractCommentEvents(payload: unknown): CommentEvent[] {
  const data = (payload && typeof payload === "object" ? payload : {}) as InstagramWebhookPayload;
  const events: CommentEvent[] = [];

  for (const entry of Array.isArray(data.entry) ? data.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field !== "comments" || !change.value || typeof change.value !== "object") {
        continue;
      }

      const value = change.value;
      const commentId = getString(value, "id") ?? getString(value, "comment_id");
      if (!commentId) {
        console.log(JSON.stringify({ level: "warn", msg: "missing_comment_id", value }));
        continue;
      }

      events.push({
        commentId,
        mediaId: getMediaId(value),
        authorId: getNestedString(value, ["from", "id"]),
        username: getNestedString(value, ["from", "username"]) ?? getString(value, "username"),
        text: getString(value, "text") ?? getString(value, "comment_text") ?? ""
      });
    }
  }

  return events;
}

function matchesKeyword(text: string, keyword: string): boolean {
  const trimmedKeyword = keyword.trim().toLowerCase();
  return trimmedKeyword.length > 0 && text.toLowerCase().includes(trimmedKeyword);
}

// The account's own comments (including the public replies this Worker posts)
// must never trigger a rule.
function isOwnerComment(event: CommentEvent, env: AppEnv): boolean {
  if (event.authorId && event.authorId === env.IG_USER_ID) {
    return true;
  }
  const owner = env.OWNER_IG_USERNAME?.trim().toLowerCase().replace(/^@/, "");
  return Boolean(owner && event.username?.toLowerCase() === owner);
}

function summarizeRule(rule: MatchedRule): Record<string, string | number> {
  return {
    id: rule.id,
    label: rule.label,
    matchedKeyword: rule.matchedKeyword,
    publicReply: rule.publicReplyText ? 1 : 0,
    linkButton: rule.linkUrl && rule.linkButtonLabel ? 1 : 0
  };
}

async function isAdminRequest(request: Request, env: AppEnv): Promise<boolean> {
  if (!env.ADMIN_TOKEN) {
    return false;
  }

  const cookie = getCookie(request.headers.get("cookie"), ADMIN_COOKIE_NAME);
  if (!cookie) {
    return false;
  }

  const [expiresText, signature] = cookie.split(".");
  const expires = Number(expiresText);
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000) || !signature) {
    return false;
  }

  const expected = await hmacHex(env.ADMIN_TOKEN, expiresText);
  return safeEqualText(signature, expected);
}

async function createAdminSession(env: AppEnv): Promise<string> {
  if (!env.ADMIN_TOKEN) {
    throw new Error("Missing ADMIN_TOKEN");
  }

  const expires = Math.floor(Date.now() / 1000) + ADMIN_SESSION_TTL_SECONDS;
  const signature = await hmacHex(env.ADMIN_TOKEN, String(expires));
  return `${expires}.${signature}`;
}

async function isValidMetaSignature(
  rawBody: ArrayBuffer,
  signatureHeader: string | null,
  appSecret: string
): Promise<boolean> {
  if (!appSecret || !signatureHeader?.startsWith("sha256=")) {
    return false;
  }

  const provided = hexToBytes(signatureHeader.slice("sha256=".length));
  if (!provided) {
    return false;
  }

  const expected = hexToBytes(await hmacHex(appSecret, rawBody));
  return Boolean(expected && constantTimeEqual(expected, provided));
}

async function hmacHex(secret: string, data: string | ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const payload = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, payload));
  return bytesToHex(signature);
}

async function safeEqualText(a: string, b: string): Promise<boolean> {
  return constantTimeEqual(new TextEncoder().encode(a), new TextEncoder().encode(b));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let mismatch = a.length ^ b.length;
  const maxLength = Math.max(a.length, b.length);

  for (let index = 0; index < maxLength; index += 1) {
    mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }

  return mismatch === 0;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    return null;
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseJsonBody(rawBody: ArrayBuffer): unknown {
  const text = new TextDecoder().decode(rawBody);
  return parseJsonText(text);
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function getMediaId(value: Record<string, unknown>): string | null {
  return (
    getNestedString(value, ["media", "id"]) ??
    getString(value, "media_id") ??
    getString(value, "mediaId")
  );
}

function getString(value: Record<string, unknown>, key: string): string | null {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function getNestedString(value: Record<string, unknown>, path: string[]): string | null {
  let current: unknown = value;

  for (const part of path) {
    if (!current || typeof current !== "object") {
      return null;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return typeof current === "string" && current.length > 0 ? current : null;
}

function getFormString(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

function getCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) {
    return null;
  }

  for (const cookie of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = cookie.trim().split("=");
    if (rawName === name) {
      return rawValue.join("=");
    }
  }

  return null;
}

function buildCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location,
      ...headers
    }
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function html(markup: string, status = 200): Response {
  return new Response(markup, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
