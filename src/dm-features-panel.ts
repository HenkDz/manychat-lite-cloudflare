import {
  buildReplyLink,
  MAX_CUSTOM_REPLIES,
  MAX_STARTERS,
  MAX_STORY_RULES,
  parseReplyRef,
  type CustomReply,
  type DmFeatureSettings,
  type IceBreakersPublicationStatus,
  type StoryRule
} from "./dm-features";

// A reply that a starter, story rule or DM link can point at.
export type ReplyOption = { key: string; label: string; group: "rule" | "text"; detail: string };

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function replyOptions(options: ReplyOption[], selected: string): string {
  const groups: Array<[ReplyOption["group"], string]> = [["rule", "Keyword automations"], ["text", "Custom replies"]];
  const missing = selected && !options.some((option) => option.key === selected)
    ? `<option value="${esc(selected)}" selected>Removed reply (choose another)</option>` : "";
  const body = groups.map(([group, label]) => {
    const items = options.filter((option) => option.group === group);
    return items.length
      ? `<optgroup label="${label}">${items.map((option) => `<option value="${esc(option.key)}" ${option.key === selected ? "selected" : ""}>${esc(option.label)}${option.detail ? ` · ${esc(option.detail)}` : ""}</option>`).join("")}</optgroup>`
      : "";
  }).join("");
  return missing + (body || '<option value="">Add an automation or custom reply first</option>');
}

function displayTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return esc(value);
  return `<time datetime="${esc(date.toISOString())}">${esc(date.toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC"
  }))} UTC</time>`;
}

function publication(status: IceBreakersPublicationStatus, enabled: boolean): string {
  const label = status.state === "synced"
    ? enabled ? "Published" : "Removed from Instagram"
    : status.state === "pending" ? "Changes not published"
      : status.state === "error" ? "Publishing failed" : "Not published";
  return `<div class="dm-publish-status"><span class="badge ${status.state === "synced" ? "green" : "amber"}"><i></i>${label}</span>
    ${status.syncedAt ? `<span class="field-help">Last updated on Instagram: ${displayTime(status.syncedAt)}</span>` : ""}
    ${status.error ? `<p class="dm-publish-error" role="status">${esc(status.error)}</p>` : ""}</div>`;
}

export function renderDmFeaturesPanel(data: {
  settings: DmFeatureSettings;
  publication: IceBreakersPublicationStatus;
  options: ReplyOption[];
  username: string | null;
  dryRun: boolean;
}): string {
  const { settings, options } = data;
  const normalizedUsername = (data.username ?? "").trim().replace(/^@/, "");
  const canBuildLinks = /^[A-Za-z0-9._]{1,30}$/.test(normalizedUsername);
  const defaultReply = options[0]?.key ?? "";
  return `<section class="panel dm-tools" id="dm-tools" aria-labelledby="dm-tools-title">
    <div class="section-heading"><h2 id="dm-tools-title">DM tools</h2></div>
    <form action="/admin/dm-features" method="post" id="dm-feature-settings" class="dm-settings-form">
      <div class="dm-settings-grid">
        <section class="dm-feature" aria-labelledby="dm-starters-title">
          <h3 id="dm-starters-title">Conversation starters</h3>
          <p class="dm-description">Give people up to ${MAX_STARTERS} buttons when they open a new chat. Each button sends an automation's DM or a custom reply.</p>
          <label class="switch-label dm-switch"><input type="checkbox" name="starters_enabled" ${settings.startersEnabled ? "checked" : ""}><span class="switch"></span>Show conversation starters</label>
          <div class="dm-starter-list">${Array.from({ length: MAX_STARTERS }, (_, index) => {
            const starter = settings.starters[index];
            return `<div class="dm-starter-row"><span class="dm-row-number" aria-hidden="true">${index + 1}</span><label>Button ${index + 1}<input name="starter_title" value="${esc(starter?.title ?? "")}" maxlength="80" placeholder="Leave blank to skip"></label><label>Reply<select name="starter_reply">${replyOptions(options, starter?.reply ?? defaultReply)}</select></label></div>`;
          }).join("")}</div>
          <div class="dm-keyword-replies">
            <h3>Keyword replies in DMs</h3>
            <label class="switch-label dm-switch"><input type="checkbox" name="keyword_replies_enabled" ${settings.keywordRepliesEnabled ? "checked" : ""}><span class="switch"></span>Reply when a DM contains an automation keyword</label>
            <p class="field-help">Whole words only, from active automations. Requires the <code>messages</code> webhook.</p>
          </div>
        </section>
        <section class="dm-feature" aria-labelledby="dm-followers-title">
          <h3 id="dm-followers-title">Follower status</h3>
          <p class="dm-description">Use a different opening line for followers and people who don’t follow you.</p>
          <label class="switch-label dm-switch"><input type="checkbox" name="follower_check_enabled" ${settings.followerCheckEnabled ? "checked" : ""}><span class="switch"></span>Check follower status for incoming DMs</label>
          <div class="stack"><label>For followers <span class="optional">optional</span><textarea name="follower_reply" rows="2" maxlength="80" placeholder="Thanks for following!">${esc(settings.followerReply)}</textarea></label>
          <label>For people who don’t follow you <span class="optional">optional</span><textarea name="non_follower_reply" rows="2" maxlength="80" placeholder="Thanks for getting in touch!">${esc(settings.nonFollowerReply)}</textarea></label></div>
          <p class="field-help dm-follow-help">Up to 80 characters. Added before a reply when it fits Instagram's limit. Blank lines or unavailable follower status use the usual message.</p>
          <p class="dm-description dm-follow-note">This checks people who message you or tap a starter. Results are kept for up to 24 hours. It does not send DMs to new followers.</p>
        </section>
      </div>
      <div class="form-actions dm-save-actions"><span class="field-help">Saving settings does not send a message or publish starters.</span><button class="button primary">Save DM settings</button></div>
    </form>
    <div class="dm-publish-row">${publication(data.publication, settings.startersEnabled)}<form action="/admin/dm-features/publish" method="post" id="dm-publish-form"><button class="button secondary" data-publish-starters ${data.dryRun ? "disabled" : ""}>${settings.startersEnabled ? "Publish saved starters" : "Remove starters from Instagram"}</button></form><p class="field-help dm-publish-help" id="dm-publish-help">${data.dryRun ? "Publishing is off in test mode." : "Save your changes before publishing. Starters appear in the Instagram mobile app."}</p></div>
    ${customReplies(settings.customReplies)}
    <section class="dm-feature dm-story-section" aria-labelledby="dm-story-title"><div class="section-heading"><h3 id="dm-story-title">Story replies</h3><span class="count">${settings.storyRules.length} of ${MAX_STORY_RULES}</span></div>
      <p class="dm-description">Choose a story, a keyword, or both. A blank story applies to all story replies. Rules for a specific story take priority, and a paused rule blocks broader ones.</p>
      <p class="field-help dm-story-help">Use a story ID or link-sticker URL when possible. Temporary story media links can expire.</p>
      ${storyRules(settings.storyRules, options)}
      ${settings.storyRules.length < MAX_STORY_RULES ? `<details class="dm-add-story"><summary>Add a story rule</summary><form action="/admin/story-rules" method="post" class="stack dm-new-story-form">
        <input type="hidden" name="action" value="save"><div class="two-fields"><label>Rule name<input name="label" required maxlength="80" placeholder="Workshop story"></label><label>Reply<select name="reply">${replyOptions(options, defaultReply)}</select></label></div>
        <div class="two-fields"><label>Story ID <span class="optional">optional</span><input name="story_id" maxlength="40" inputmode="numeric" pattern="[0-9]*" placeholder="From recent activity"></label><label>Keyword <span class="optional">optional</span><input name="keyword" maxlength="80" placeholder="WORKSHOP"></label></div>
        <label>Story or link-sticker URL <span class="optional">optional</span><input name="story_url" type="url" maxlength="2000" placeholder="https://…"></label>
        <p class="field-help">Add at least a story ID, a URL, or a keyword.</p><div class="form-actions"><label class="switch-label"><input type="checkbox" name="enabled" checked><span class="switch"></span>Enabled</label><button class="button primary">Add story rule</button></div>
      </form></details>` : ""}
    </section>
    <section class="dm-feature dm-flow-links" aria-labelledby="dm-links-title" data-dm-link-username="${esc(canBuildLinks ? normalizedUsername : "")}"><div class="section-heading"><h3 id="dm-links-title">Links to your DMs</h3>${canBuildLinks ? `<span class="muted small">@${esc(normalizedUsername)}</span>` : ""}</div>
      <p class="dm-description">Share a link that opens a chat with a specific reply. Add a source to see where people came from.</p>
      <label class="dm-link-source">Source <span class="optional">optional</span><input id="dm-link-source" value="website" maxlength="80" pattern="[A-Za-z0-9_\\-]{1,80}" placeholder="website" aria-describedby="dm-link-source-help"><span class="field-help" id="dm-link-source-help">Letters, numbers, hyphens, and underscores. For example: website or newsletter.</span></label>
      ${canBuildLinks
        ? options.length
          ? `<div class="dm-links-list">${options.map((option, index) => `<div class="dm-link-row"><label for="dm-link-${index}">${esc(option.label)}</label><input id="dm-link-${index}" data-reply-key="${esc(option.key)}" value="${esc(buildReplyLink(normalizedUsername, option.key, "website"))}" readonly aria-label="${esc(option.label)} DM link"><button type="button" class="button secondary" data-copy-dm-link="dm-link-${index}">Copy<span class="sr-only"> ${esc(option.label)} link</span></button></div>`).join("")}</div>`
          : '<p class="dm-empty-stories">Add an automation or custom reply to get links.</p>'
        : '<p class="notice">Check your Instagram connection, or set OWNER_IG_USERNAME, to load links for your account.</p>'}
      <p id="dm-link-feedback" class="field-help dm-link-feedback" role="status" aria-live="polite"></p><p class="field-help">Opens Instagram on mobile. New chats start after a message or button tap.</p>
    </section>
  </section>`;
}

function customReplies(replies: CustomReply[]): string {
  return `<section class="dm-feature dm-custom-section" aria-labelledby="dm-custom-title"><div class="section-heading"><h3 id="dm-custom-title">Custom replies</h3><span class="count">${replies.length} of ${MAX_CUSTOM_REPLIES}</span></div>
    <p class="dm-description">Text replies for starters, story rules and DM links that don't belong to a keyword automation.</p>
    ${replies.length ? `<div class="dm-custom-list">${replies.map((reply) => `<details class="dm-custom"><summary><strong>${esc(reply.label)}</strong><span>${esc(reply.text.length > 140 ? `${reply.text.slice(0, 137)}…` : reply.text)}</span></summary>
      <form action="/admin/custom-replies" method="post" class="stack"><input type="hidden" name="id" value="${esc(reply.id)}"><label>Name<input name="label" value="${esc(reply.label)}" maxlength="80" required></label><label>Message<textarea name="text" rows="3" maxlength="1000" required>${esc(reply.text)}</textarea></label>
      <div class="form-actions"><span class="dm-reply-key">text-${esc(reply.id)}</span><div><button class="button danger" name="action" value="delete" formnovalidate data-confirm="Delete this custom reply?">Delete</button><button class="button primary" name="action" value="save">Save reply</button></div></div></form></details>`).join("")}</div>` : '<p class="dm-empty-stories">No custom replies yet.</p>'}
    ${replies.length < MAX_CUSTOM_REPLIES ? `<details class="dm-add-story"><summary>Add a custom reply</summary><form action="/admin/custom-replies" method="post" class="stack dm-new-story-form">
      <input type="hidden" name="action" value="save"><label>Name<input name="label" required maxlength="80" placeholder="Ask a question"></label><label>Message<textarea name="text" rows="3" maxlength="1000" required placeholder="Send your question here and I will reply soon."></textarea></label>
      <div class="form-actions"><span class="field-help">Up to 1,000 characters.</span><button class="button primary">Add custom reply</button></div>
    </form></details>` : ""}
  </section>`;
}

function storyRules(rules: StoryRule[], options: ReplyOption[]): string {
  if (!rules.length) return '<p class="dm-empty-stories">No story rules yet.</p>';
  return `<div class="table-scroll"><table class="dm-story-table"><thead><tr><th>Rule</th><th>Story</th><th>Keyword</th><th>Reply</th><th>Enabled</th><th>Actions</th></tr></thead><tbody>${rules.map((rule, index) => {
    const formId = `dm-story-rule-${index}`;
    return `<tr><td data-column="Rule"><form action="/admin/story-rules" method="post" id="${formId}"><input type="hidden" name="id" value="${esc(rule.id)}"><input name="label" value="${esc(rule.label)}" maxlength="80" required aria-label="Rule name"></form></td>
      <td data-column="Story"><div class="dm-story-target"><input name="story_id" maxlength="40" form="${formId}" value="${esc(rule.storyId)}" pattern="[0-9]*" inputmode="numeric" placeholder="Any story · add ID" aria-label="Story ID"><input name="story_url" form="${formId}" value="${esc(rule.storyUrl)}" type="url" maxlength="2000" placeholder="Story or link-sticker URL" aria-label="Story or link-sticker URL"></div></td>
      <td data-column="Keyword"><input name="keyword" form="${formId}" value="${esc(rule.keyword)}" maxlength="80" placeholder="Any reply" aria-label="Story reply keyword"></td>
      <td data-column="Reply"><select name="reply" form="${formId}" aria-label="Story response">${replyOptions(options, rule.reply)}</select></td>
      <td data-column="Enabled"><label class="switch-label dm-table-switch"><input type="checkbox" name="enabled" form="${formId}" ${rule.enabled ? "checked" : ""}><span class="switch"></span><span class="sr-only">Enable ${esc(rule.label)}</span></label></td>
      <td data-column="Actions"><div class="dm-story-actions"><button class="button secondary" name="action" value="save" form="${formId}">Save</button><button class="button danger" name="action" value="delete" form="${formId}" formnovalidate data-confirm="Delete this story rule?">Delete</button></div></td></tr>`;
  }).join("")}</tbody></table></div>`;
}

export type DmMessageContext = {
  source?: string | null;
  referral_ref?: string | null;
  story_id?: string | null;
  story_url?: string | null;
  story_link_url?: string | null;
  is_follower?: number | null;
  profile_error?: string | null;
  profile_checked_at?: string | null;
};

const SOURCE_NAMES: Record<string, string> = {
  dm: "Direct message",
  starter: "Conversation starter",
  story_reply: "Story reply",
  story_mention: "Story mention",
  referral: "DM link",
  postback: "Button tap"
};

/** Where an incoming DM came from, shown under each DM in the activity list. */
export function renderDmMessageContext(row: DmMessageContext): string {
  const parts: string[] = [];
  if (row.source) parts.push(`<span>${esc(SOURCE_NAMES[row.source] ?? row.source.replace(/_/g, " "))}</span>`);
  if (row.referral_ref) {
    const source = parseReplyRef(row.referral_ref)?.source ?? null;
    parts.push(`<span>Link source: ${esc(source ?? row.referral_ref)}</span>`);
  }
  if (row.is_follower === 1) parts.push('<span class="dm-follower">Follows you</span>');
  else if (row.is_follower === 0) parts.push("<span>Doesn’t follow you</span>");
  else if (row.profile_checked_at || row.profile_error) parts.push("<span>Follower status unavailable</span>");
  if (row.story_id) parts.push(`<span class="dm-story-id">Story ID: ${esc(row.story_id)}</span>`);
  const link = row.story_link_url || row.story_url;
  if (link) {
    try {
      const url = new URL(link);
      if (url.protocol === "https:" && !url.username && !url.password) {
        parts.push(`<a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${row.story_link_url ? "Story link sticker" : "Story media"} ↗</a>`);
      }
    } catch { /* Omit malformed activity links. */ }
  }
  return parts.length ? `<div class="dm-message-context">${parts.join("")}</div>` : "";
}

export const dmFeaturesClientScript = `
(() => {
  const form = document.getElementById('dm-feature-settings');
  const publish = document.querySelector('[data-publish-starters]');
  const publishHelp = document.getElementById('dm-publish-help');
  if (form && publish && !publish.disabled) {
    const markUnsaved = () => { publish.disabled = true; publishHelp.textContent = 'Save your changes before publishing.'; };
    form.addEventListener('input', markUnsaved);
    form.addEventListener('change', markUnsaved);
  }
  document.querySelectorAll('[data-confirm]').forEach(button => button.addEventListener('click', event => {
    if (!confirm(button.dataset.confirm)) event.preventDefault();
  }));
  const panel = document.querySelector('[data-dm-link-username]');
  if (!panel || !panel.dataset.dmLinkUsername) return;
  const source = document.getElementById('dm-link-source');
  const feedback = document.getElementById('dm-link-feedback');
  const linkInputs = [...panel.querySelectorAll('[data-reply-key]')];
  const copyButtons = [...panel.querySelectorAll('[data-copy-dm-link]')];
  source.addEventListener('input', () => {
    const value = source.value.trim() || 'website';
    const valid = /^[A-Za-z0-9_-]{1,80}$/.test(value);
    source.setAttribute('aria-invalid', String(!valid));
    feedback.textContent = valid ? '' : 'Use letters, numbers, hyphens, or underscores for the source.';
    copyButtons.forEach(button => { button.disabled = !valid; });
    linkInputs.forEach(input => {
      input.value = valid ? 'https://ig.me/' + encodeURIComponent(panel.dataset.dmLinkUsername) + '?ref=' + input.dataset.replyKey + '__' + value : '';
    });
  });
  copyButtons.forEach(button => button.addEventListener('click', async () => {
    const input = document.getElementById(button.dataset.copyDmLink);
    if (!input || !input.value) return;
    try { await navigator.clipboard.writeText(input.value); feedback.textContent = 'Link copied.'; }
    catch { input.focus(); input.select(); feedback.textContent = 'Link selected. Copy it with your keyboard.'; }
  }));
})();
`;

export const dmFeaturesStyles = `
.dm-tools{margin-top:24px}.dm-tools h3{font-size:14px;font-weight:600;letter-spacing:-.2px;margin:0}.dm-settings-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:30px}.dm-description{font-size:11px;line-height:1.75;color:var(--muted);margin:8px 0 16px}.dm-switch{margin:17px 0;line-height:1.6}.dm-starter-list{display:flex;flex-direction:column;gap:12px}.dm-starter-row{display:grid;grid-template-columns:19px minmax(0,1fr) 130px;gap:8px;align-items:end}.dm-row-number{color:#99a28f;font-size:10px;padding-bottom:12px}.dm-starter-row input,.dm-starter-row select{padding:10px;font-size:11px}.dm-follow-help{margin-top:12px}.dm-follow-note{padding:12px;background:#f7f9f2;border:1px solid var(--line);border-radius:7px;margin-top:17px}.dm-save-actions{margin-top:23px}.dm-publish-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:13px;padding:19px 0 22px}.dm-publish-status{display:flex;align-items:center;flex-wrap:wrap;gap:10px;flex:1;min-width:0}.dm-publish-error{flex-basis:100%;font-size:11px;color:#9b504a;overflow-wrap:anywhere}.dm-publish-help{flex-basis:100%}.dm-tools button:disabled{opacity:.5;cursor:not-allowed}.dm-story-section,.dm-flow-links{border-top:1px solid var(--line);padding-top:22px;margin-top:5px}.dm-story-section>.section-heading,.dm-flow-links>.section-heading{margin-bottom:8px}.dm-story-help{margin-top:-8px;margin-bottom:16px}.dm-story-table{min-width:820px}.dm-story-table th{font-size:9px}.dm-story-table td{padding:13px 9px;vertical-align:middle}.dm-story-table td:first-child{padding-left:0;width:20%}.dm-story-table td:nth-child(2){width:25%}.dm-story-table td:nth-child(3){width:15%}.dm-story-table input,.dm-story-table select{font-size:10px;padding:9px;min-width:0}.dm-story-table select{min-width:105px}.dm-story-target{display:flex;flex-direction:column;gap:7px}.dm-story-actions{display:flex;flex-direction:column;gap:5px}.dm-story-actions .button{font-size:9px;padding:7px 10px}.dm-table-switch{justify-content:center}.dm-add-story{border:1px solid var(--line);border-radius:8px;padding:14px;margin-top:15px}.dm-add-story>summary{font-size:11px;font-weight:600;cursor:pointer}.dm-new-story-form{padding-top:18px}.dm-empty-stories{font-size:11px;color:var(--muted);margin:20px 0}.dm-flow-links{margin-top:25px}.dm-link-source{max-width:400px;margin-bottom:18px}.dm-links-list{display:flex;flex-direction:column;gap:9px}.dm-link-row{display:grid;grid-template-columns:100px minmax(0,1fr) auto;align-items:center;gap:12px}.dm-link-row>label{font-size:11px}.dm-link-row input{font-family:ui-monospace,SFMono-Regular,monospace;font-size:10px;background:#fafbf7}.dm-link-row .button{font-size:10px;padding:10px 15px}.dm-link-feedback{min-height:17px;margin:12px 0 3px}.dm-message-context{display:flex;align-items:center;flex-wrap:wrap;gap:5px 11px;font-size:9px;line-height:1.7;color:#849077;margin-top:7px}.dm-message-context>span+span:before{content:'·';margin-right:9px;color:#bbc2b1}.dm-message-context a{text-decoration:underline;text-underline-offset:3px}.dm-message-context .dm-follower{color:#648446}.dm-message-context .dm-story-id{overflow-wrap:anywhere}
@media(max-width:1000px){.dm-settings-grid{gap:22px}.dm-starter-row{grid-template-columns:15px minmax(0,1fr) 110px;gap:6px}.dm-link-row{grid-template-columns:85px minmax(0,1fr) auto;gap:9px}.dm-starter-row input,.dm-starter-row select{font-size:10px;padding:9px}}
@media(max-width:760px){.dm-settings-grid{grid-template-columns:1fr;gap:25px}.dm-settings-grid>.dm-feature+section{padding-top:22px;border-top:1px solid var(--line)}.dm-starter-row{grid-template-columns:19px minmax(0,1fr) 130px}.dm-tools h3{font-size:15px}.dm-description{font-size:12px}.dm-publish-status{flex-basis:100%}.dm-story-table{min-width:0}.dm-story-table thead{display:none}.dm-story-table,.dm-story-table tbody{display:block;width:100%}.dm-story-table tr{display:grid;grid-template-columns:1fr 1fr;gap:13px;padding:16px 0;border-bottom:1px solid var(--line)}.dm-story-table td{display:block;width:auto!important;padding:0;border:0;min-width:0}.dm-story-table td:before{content:attr(data-column);display:block;font-size:10px;color:#69785e;margin-bottom:6px}.dm-story-table td:first-child,.dm-story-table td:nth-child(2){grid-column:1/-1}.dm-story-target{display:grid;grid-template-columns:1fr 1fr}.dm-story-table input,.dm-story-table select{font-size:11px}.dm-table-switch{justify-content:flex-start;height:32px}.dm-story-actions{flex-direction:row}.dm-story-actions .button{font-size:10px;padding:9px 13px}.dm-link-row{grid-template-columns:minmax(0,1fr) auto;gap:7px}.dm-link-row>label{grid-column:1/-1}.dm-link-row input{font-size:10px}.dm-links-list{gap:15px}.dm-save-actions{align-items:flex-start}.dm-save-actions>.field-help{max-width:55%}}
@media(max-width:420px){.dm-starter-row{grid-template-columns:14px minmax(0,1fr) 110px}.dm-story-target{grid-template-columns:1fr}.dm-save-actions{flex-wrap:wrap}.dm-save-actions>.field-help{max-width:none}.dm-save-actions>.button{width:100%}}
.dm-keyword-replies{margin-top:20px;padding-top:18px;border-top:1px solid var(--line)}.dm-keyword-replies .dm-switch{margin:12px 0 8px}
.dm-custom-section{border-top:1px solid var(--line);padding-top:22px;margin-top:5px}.dm-custom-section>.section-heading{margin-bottom:8px}.dm-custom-list{display:flex;flex-direction:column;gap:9px;margin-bottom:4px}.dm-custom{border:1px solid var(--line);border-radius:8px;background:#fff}.dm-custom>summary{display:flex;flex-direction:column;gap:4px;padding:12px 14px;cursor:pointer;list-style:none}.dm-custom>summary::-webkit-details-marker{display:none}.dm-custom>summary strong{font-size:12px;font-weight:600;color:#42573f}.dm-custom>summary span{font-size:10px;color:var(--muted);line-height:1.6;overflow-wrap:anywhere}.dm-custom[open]{border-color:#a8b88d}.dm-custom>form{border-top:1px solid var(--line);padding:14px}.dm-custom .form-actions{padding-top:12px}
.dm-starter-row{grid-template-columns:19px minmax(0,1fr) minmax(0,.9fr)}
@media(max-width:1000px){.dm-starter-row{grid-template-columns:15px minmax(0,1fr) minmax(0,.9fr)}}
@media(max-width:760px){.dm-starter-row{grid-template-columns:19px minmax(0,1fr) minmax(0,.9fr)}}
@media(max-width:420px){.dm-starter-row{grid-template-columns:14px minmax(0,1fr) minmax(0,1fr)}}
.dm-reply-key{font-family:ui-monospace,SFMono-Regular,monospace;font-size:9px;color:#93a07f}.dm-link-row>label{overflow-wrap:anywhere}.dm-tools code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:.95em}.dm-publish-row form{margin:0}
`;
