import { tavily, TavilyClient } from "@tavily/core";
import { WebSearchParams, ToolResult } from "../types";

const DDG_MAX_RESULTS = 8;

let _client: TavilyClient | null = null;

function getClient(): TavilyClient {
  if (!_client) {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) throw new Error("TAVILY_API_KEY is not set.");
    _client = tavily({ apiKey });
  }
  return _client;
}

async function searchDuckDuckGo(query: string): Promise<ToolResult> {
  console.log(`[web_search]-[duckduckgo] fallback query="${query}"`);

  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res = await fetch(url);
  const data = await res.json() as any;

  const results: { title: string; url: string }[] = [];

  if (Array.isArray(data.RelatedTopics)) {
    for (const topic of data.RelatedTopics) {
      if (topic.FirstURL && topic.Text && results.length < DDG_MAX_RESULTS) {
        results.push({ title: topic.Text, url: topic.FirstURL });
      }
    }
  }

  if (results.length === 0) {
    return { success: true, output: "No results found (DuckDuckGo fallback)." };
  }

  const formatted = results
    .map((r, i) => [`[${i + 1}] ${r.title}`, `URL: ${r.url}`].join("\n"))
    .join("\n\n---\n\n");

  console.log(`[web_search]-[duckduckgo] got ${results.length} results`);
  return { success: true, output: formatted };
}

export async function web_search(params: WebSearchParams): Promise<ToolResult> {
  const { query } = params;

  try {
    const client = getClient();
    console.log(`[web_search]-[tavily] query="${query}"`);

    const response = await client.search(query, {
      searchDepth: "advanced",
      includeImages: false,
    });

    const results = response.results ?? [];
    console.log(`[web_search]-[tavily] got ${results.length} results`);

    const formatted = results
      .map((r, i) =>
        [
          `[${i + 1}] ${r.title}`,
          `URL: ${r.url}`,
          `Score: ${r.score?.toFixed(3) ?? "n/a"}`,
          r.content?.trim() ?? "",
        ].join("\n"),
      )
      .join("\n\n---\n\n");

    return { success: true, output: formatted || "No results found." };
  } catch (tavilyErr: any) {
    console.warn(`[web_search]-[tavily] failed (${tavilyErr.message}) — falling back to DuckDuckGo`);

    try {
      return await searchDuckDuckGo(query);
    } catch (ddgErr: any) {
      console.error(`[web_search]-[duckduckgo] also failed: ${ddgErr.message}`);
      return { success: false, error: `Tavily: ${tavilyErr.message} | DuckDuckGo: ${ddgErr.message}` };
    }
  }
}
