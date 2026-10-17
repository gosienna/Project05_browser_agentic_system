// Builtin Flow session: open Google weather search, then LLM-extract Taipei weather.

export const BUILTIN_WEATHER_TAIPEI_ID = "weather-taipei";

export const WEATHER_TAIPEI_URL = "https://www.google.com/search?q=wheather+taipei";

const NODE1_SCRIPT = `const tab = await api.open_tab({ url: inputs.url });
await api.wait(2500);
outputs.tabId = tab.id;
outputs.url = inputs.url || tab.url;`;

const NODE2_SCRIPT = `let tabId = inputs.tabId;
if (tabId == null) {
  const tabs = await api.list_tabs();
  const hit = (tabs || []).find((t) => String(t.url || "").includes("google.com/search") && String(t.url || "").includes("taipei"));
  if (!hit) throw new Error("No Google Taipei weather tab found — run node 1 first or set inputs.tabId");
  tabId = hit.id;
}
const snap = await api.browser_snapshot({ tabId, maxChars: 12000 });
const text = typeof snap === "string" ? snap : (snap?.snapshot || JSON.stringify(snap));
const weather = await api.llm(
  "Extract the current weather in Taipei from this page content. Reply with a short factual summary only.\\n\\n" + text
);
outputs.tabId = tabId;
outputs.weather = weather;`;

export function buildWeatherTaipeiSession(now = Date.now()) {
  return {
    id: BUILTIN_WEATHER_TAIPEI_ID,
    title: "Taipei weather",
    isBuiltin: true,
    nodes: [
      {
        id: "n1",
        title: "Open Google weather search",
        inputs: { url: WEATHER_TAIPEI_URL },
        script: NODE1_SCRIPT,
        outputs: null,
        status: "idle",
        error: null,
      },
      {
        id: "n2",
        title: "Extract Taipei weather via LLM",
        inputs: {},
        script: NODE2_SCRIPT,
        outputs: null,
        status: "idle",
        error: null,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}
