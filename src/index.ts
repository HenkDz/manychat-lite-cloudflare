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
  username: string | null;
  text: string;
};

type Rule = {
  id: number;
  label: string;
  keywords: string[];
  replyText: string;
  publicReplyText: string | null;
  linkUrl: string | null;
  linkButtonLabel: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
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

type RecentEventRow = {
  comment_id: string;
  username: string | null;
  comment_text: string;
  status: string;
  rule_label: string | null;
  matched_keyword: string | null;
  error: string | null;
  received_at: string;
  sent_at: string | null;
};

type ActivityFilters = {
  status: string;
  keyword: string;
  username: string;
  date: string;
};

type RuleAnalyticsRow = {
  rule_id: number;
  rule_label: string;
  comments_received: number;
  matched_count: number;
  dm_sent_count: number;
  error_count: number;
  last_sent_at: string | null;
};

type RetryEventRow = {
  comment_id: string;
  matched_rule_id: number | null;
  matched_keyword: string | null;
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

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

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

  const dryRun = (env.DRY_RUN ?? "true").toLowerCase() !== "false";
  if (dryRun) {
    await updateStatus(env.DB, event.commentId, "dry_run_matched", true, rule);
    console.log(JSON.stringify({ level: "info", msg: "dry_run_private_reply", event, rule: summarizeRule(rule) }));
    return;
  }

  try {
    const result = await sendRuleResponses(env, event.commentId, rule);
    await updateEventAfterSend(env.DB, event.commentId, rule, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare(
      `UPDATE comment_events
       SET matched = 1,
           status = ?,
           error = ?,
           matched_rule_id = ?,
           matched_keyword = ?,
           rule_label = ?
       WHERE comment_id = ?`
    )
      .bind("send_error", message, rule.id, rule.matchedKeyword, rule.label, event.commentId)
      .run();
    console.error(JSON.stringify({ level: "error", msg: "private_reply_failed", commentId: event.commentId, error: message }));
  }
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
  let publicReply: unknown = null;
  let publicReplyError: string | null = null;

  if (rule.publicReplyText) {
    try {
      publicReply = await sendPublicCommentReply(env, commentId, rule.publicReplyText);
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
    sentAt: new Date().toISOString()
  };
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

  const fallbackKeyword = env.KEYWORD?.trim();
  if (!fallbackKeyword || !matchesKeyword(text, fallbackKeyword)) {
    return null;
  }

  return {
    id: 0,
    label: "Fallback rule",
    keywords: [fallbackKeyword],
    replyText: env.PRIVATE_REPLY_TEXT ?? "Thanks for commenting.",
    publicReplyText: null,
    linkUrl: null,
    linkButtonLabel: null,
    active: true,
    createdAt: "",
    updatedAt: "",
    matchedKeyword: fallbackKeyword
  };
}

async function sendPrivateReply(
  env: AppEnv,
  commentId: string,
  message: string,
  linkUrl: string | null,
  linkButtonLabel: string | null
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
    body: JSON.stringify({
      recipient: { comment_id: commentId },
      message: buildPrivateReplyMessage(message, linkUrl, linkButtonLabel)
    })
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
    dryRun: (env.DRY_RUN ?? "true").toLowerCase() !== "false",
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

  const event = await getRetryEvent(env.DB, commentId);
  if (!event?.matched_rule_id) {
    return html(renderErrorPage("That comment does not have a matched rule to retry."), 400);
  }

  const rule = await getRuleById(env.DB, event.matched_rule_id);
  if (!rule) {
    return html(renderErrorPage("The matched rule no longer exists."), 400);
  }

  const matchedRule: MatchedRule = {
    ...rule,
    matchedKeyword: event.matched_keyword ?? rule.keywords[0] ?? ""
  };

  try {
    const result = await sendRuleResponses(env, commentId, matchedRule);
    await updateEventAfterSend(env.DB, commentId, matchedRule, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare(
      `UPDATE comment_events
       SET status = ?,
           error = ?,
           matched = 1,
           matched_rule_id = ?,
           matched_keyword = ?,
           rule_label = ?
       WHERE comment_id = ?`
    )
      .bind("send_error", message, matchedRule.id, matchedRule.matchedKeyword, matchedRule.label, commentId)
      .run();
    console.error(JSON.stringify({ level: "error", msg: "retry_private_reply_failed", commentId, error: message }));
  }

  return redirect("/admin?saved=1");
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
    `SELECT comment_id, matched_rule_id, matched_keyword
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
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    clauses.push("received_at >= ? AND received_at < ?");
    bindings.push(start.toISOString(), end.toISOString());
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
  const data = payload as InstagramWebhookPayload;
  const events: CommentEvent[] = [];

  for (const entry of data.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "comments" || !change.value) {
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

function isOwnerComment(event: CommentEvent, env: AppEnv): boolean {
  const owner = env.OWNER_IG_USERNAME?.trim().toLowerCase();
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
      "content-type": "text/html; charset=utf-8"
    }
  });
}

function renderLoginPage(invalid: boolean): string {
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

function renderMissingAdminTokenPage(): string {
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

function renderErrorPage(message: string): string {
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

function renderDashboardPage(data: {
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
              <span>Public reply</span>
              <textarea name="public_reply_text" rows="2" placeholder="Sent it to you."></textarea>
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
        ${renderRecentEvents(data.recentEvents)}
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
          ${renderStatusOption("sent_public_reply_error", "Public reply error", filters.status)}
          ${renderStatusOption("dry_run_matched", "Dry run", filters.status)}
          ${renderStatusOption("ignored_no_keyword", "No keyword", filters.status)}
          ${renderStatusOption("ignored_owner", "Owner", filters.status)}
          ${renderStatusOption("error", "Any error", filters.status)}
        </select>
      </label>
      <label>
        <span>Keyword</span>
        <input name="keyword" value="${escapeAttribute(filters.keyword)}" placeholder="PATHLESS">
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
          <span>Public reply</span>
          <textarea name="public_reply_text" rows="2">${escapeHtml(rule.publicReplyText ?? "")}</textarea>
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

function renderRecentEvents(events: RecentEventRow[]): string {
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
          ${isRetryableStatus(event.status) ? `
            <form class="retry-form" method="post" action="/admin/events/${encodeURIComponent(event.comment_id)}/retry">
              <button class="secondary compact" type="submit">Retry Send</button>
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

function formatStatus(status: string): string {
  return status.replace(/_/g, " ");
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
