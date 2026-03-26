function require_env(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

/** Parse "owner/repo1,owner/repo2" into [{owner, repo}, ...] */
function parseRepos(raw: string): Array<{ owner: string; repo: string }> {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [owner, repo] = s.split("/");
      if (!owner || !repo) throw new Error(`Invalid GITHUB_REPOS entry: "${s}" — expected "owner/repo"`);
      return { owner, repo };
    });
}

export const config = {
  telegram: {
    token: require_env("TELEGRAM_BOT_TOKEN"),
  },
  anthropic: {
    apiKey: require_env("ANTHROPIC_API_KEY"),
  },
  supabase: {
    url: require_env("SUPABASE_URL"),
    serviceKey: require_env("SUPABASE_SERVICE_KEY"),
  },
  github: {
    // Personal access token with repo read scope
    token: process.env["GITHUB_TOKEN"] ?? "",
    // e.g. "acme/backend,acme/frontend"
    repos: process.env["GITHUB_REPOS"]
      ? parseRepos(process.env["GITHUB_REPOS"])
      : [],
  },
  webhook: {
    domain: process.env["WEBHOOK_DOMAIN"] ?? "",
    port: parseInt(process.env["PORT"] ?? "3000", 10),
  },
  founderChatId: parseInt(require_env("FOUNDER_CHAT_ID"), 10),
} as const;
