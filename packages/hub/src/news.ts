/**
 * "AI & agents today" for the daily email: the day's top AI stories on Hacker News, the fastest-rising new agent repos on
 * GitHub, and the top Hugging Face daily papers. Public APIs only, no keys. Fetched once a day and cached in hub_meta, so a
 * restart or a second pass never refetches; any source that fails is simply left out.
 */
export interface NewsItem { src: "HN" | "GitHub" | "Paper"; title: string; url: string; meta: string }

const AI = /\b(AI|LLMs?|agents?|agentic|GPT[-\w.]*|Claude|Gemini|OpenAI|Anthropic|MCP|Llama|Mistral|DeepSeek|Qwen|inference|RAG|Copilot|Cursor|transformers?|fine-?tun\w*|embeddings?|neural|machine learning|vibe cod\w*)\b/i;

async function getJson(url: string, ms = 8000): Promise<any> {
  const r = await fetch(url, { headers: { "user-agent": "caldera-daily (+https://caldera.social)", accept: "application/json" }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

export async function hn(n = 2): Promise<NewsItem[]> {
  const since = Math.floor(Date.now() / 1000) - 86400;
  const j = await getJson(`https://hn.algolia.com/api/v1/search?tags=story&numericFilters=created_at_i%3E${since},points%3E30&hitsPerPage=300`);
  return (j.hits || []).filter((h: any) => h.title && AI.test(h.title)).sort((a: any, b: any) => b.points - a.points).slice(0, n)
    .map((h: any) => ({ src: "HN" as const, title: String(h.title), url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, meta: `${h.points} points · ${h.num_comments || 0} comments` }));
}

export async function github(n = 2): Promise<NewsItem[]> {
  const d = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10), seen = new Set<string>(), out: NewsItem[] = [];
  for (const topic of ["ai-agents", "mcp", "llm"]) {
    if (out.length >= n) break;
    const j = await getJson(`https://api.github.com/search/repositories?q=topic:${topic}+created:%3E${d}&sort=stars&order=desc&per_page=5`).catch(() => ({ items: [] }));
    for (const r of j.items || []) {
      if (out.length >= n || seen.has(r.full_name) || !/^[\x20-\x7e]*$/.test(r.description || "")) continue;   // English-language blurbs only
      seen.add(r.full_name);
      out.push({ src: "GitHub", title: r.full_name + (r.description ? ` - ${String(r.description).length > 90 ? String(r.description).slice(0, 87).trimEnd() + "..." : r.description}` : ""), url: r.html_url, meta: `${Number(r.stargazers_count).toLocaleString("en-US")} stars this week` });
    }
  }
  return out;
}

export async function papers(n = 1): Promise<NewsItem[]> {
  const j = await getJson("https://huggingface.co/api/daily_papers?limit=20");
  return (Array.isArray(j) ? j : []).filter((p: any) => p?.paper?.id && p.paper.title).sort((a: any, b: any) => (b.paper.upvotes || 0) - (a.paper.upvotes || 0)).slice(0, n)
    .map((p: any) => ({ src: "Paper" as const, title: String(p.paper.title).replace(/\s+/g, " "), url: `https://huggingface.co/papers/${p.paper.id}`, meta: `${p.paper.upvotes || 0} upvotes on Hugging Face` }));
}

/** Today's items, from the cache when this day was already fetched. */
export async function newsToday(q: (sql: string) => any): Promise<NewsItem[]> {
  const day = new Date().toISOString().slice(0, 10);
  try { const c = JSON.parse((q("SELECT v FROM hub_meta WHERE k='news_cache'").get() as any)?.v || "null"); if (c?.day === day && Array.isArray(c.items)) return c.items; } catch { /* refetch */ }
  const parts = await Promise.allSettled([hn(), github(), papers()]);
  const items = parts.flatMap(p => p.status === "fulfilled" ? p.value : []);
  if (items.length) q("INSERT OR REPLACE INTO hub_meta VALUES ('news_cache', ?)").run(JSON.stringify({ day, items }));
  return items;
}
