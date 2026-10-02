// Shapes shared by the Worker and the dashboard renderer.

export type Rule = {
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

export type RecentEventRow = {
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

export type ActivityFilters = {
  status: string;
  keyword: string;
  username: string;
  date: string;
};

export type RuleAnalyticsRow = {
  rule_id: number;
  rule_label: string;
  comments_received: number;
  matched_count: number;
  dm_sent_count: number;
  error_count: number;
  last_sent_at: string | null;
};
