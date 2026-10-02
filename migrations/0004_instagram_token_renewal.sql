-- Automatic Instagram token renewal (see src/instagram-token.ts).
-- Token values are AES-GCM encrypted by the Worker before being stored here.
-- A changed Cloudflare secret gets a separate row, so old requests cannot
-- overwrite credentials belonging to a newer deployment.
CREATE TABLE IF NOT EXISTS instagram_tokens (
  seed_fingerprint TEXT PRIMARY KEY,
  token_ciphertext TEXT NOT NULL,
  first_observed_at INTEGER NOT NULL,
  last_checked_at INTEGER,
  last_refreshed_at INTEGER,
  next_refresh_at INTEGER NOT NULL,
  expires_at INTEGER,
  username TEXT,
  needs_reconnect INTEGER NOT NULL DEFAULT 0 CHECK (needs_reconnect IN (0, 1)),
  safe_error TEXT,
  lease_owner TEXT,
  lease_until INTEGER
);
