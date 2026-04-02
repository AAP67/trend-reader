import { useState, useRef, useCallback, useEffect } from "react";
import * as XLSX from "xlsx";
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";

const SEVERITY_COLORS = {
  high: { bg: "#1a0f0f", border: "#7f1d1d", badge: "#dc2626", text: "#fca5a5" },
  medium: { bg: "#1a1508", border: "#78350f", badge: "#d97706", text: "#fcd34d" },
  low: { bg: "#0a1a14", border: "#064e3b", badge: "#059669", text: "#6ee7b7" },
};

const CHART_COLORS = ["#4f8ffa", "#a78bfa", "#34d399", "#fbbf24", "#f87171", "#818cf8"];

const SYSTEM_PROMPT = `You are an elite strategic finance analyst. You receive a dataset (as JSON rows) and the user's analytical objective.

Your job:
1. Deeply analyze the data against the stated objective
2. Identify meaningful trends, anomalies, and areas requiring human investigation
3. Be specific — reference actual column names, values, time periods, and magnitudes
4. Prioritize findings by business impact

Respond ONLY with valid JSON (no markdown, no backticks, no preamble). Use this exact schema:

{
  "summary": "2-3 sentence executive summary of the dataset and key finding",
  "trends": [
    {
      "title": "Short trend title",
      "detail": "Specific explanation with numbers and column references",
      "severity": "high|medium|low",
      "relevant_columns": ["col1", "col2"]
    }
  ],
  "anomalies": [
    {
      "title": "Short anomaly title",
      "detail": "What's unusual and why it matters",
      "severity": "high|medium|low",
      "relevant_columns": ["col1"]
    }
  ],
  "investigation_flags": [
    {
      "title": "What to investigate",
      "detail": "Why this needs human attention and what to look for",
      "severity": "high|medium|low"
    }
  ]
}

Rules:
- Return 3-5 items per category minimum
- Every finding must reference specific data points
- Severity should reflect business impact, not statistical significance
- Be opinionated — say what you think is happening, don't hedge`;

const CHAT_SYSTEM_PROMPT = `You are an elite strategic finance analyst continuing a conversation about a dataset. You have already provided an initial analysis and the user is now asking follow-up questions.

You have access to:
1. The original dataset context (columns, summary stats, sample rows)
2. Your initial analysis findings
3. The conversation history

Rules:
- Be specific — reference actual data points, column names, values
- If the user asks you to drill into something, give granular detail
- If the user asks a "what if" scenario, model it with the data you have and state assumptions clearly
- Keep responses concise but thorough — 2-4 paragraphs max unless they ask for more
- You can use **bold** for emphasis
- Be opinionated and direct — don't hedge

CHARTS:
When the user asks you to "chart", "graph", "visualize", "show me a chart", or "plot" something, include a chart specification in your response using this exact format:

|||CHART|||
{
  "type": "bar",
  "title": "Chart Title",
  "xKey": "category_field",
  "lines": [
    { "key": "value_field", "label": "Display Label" }
  ],
  "data": [
    { "category_field": "Label1", "value_field": 100 },
    { "category_field": "Label2", "value_field": 200 }
  ]
}
|||ENDCHART|||

Chart rules:
- type must be one of: "line", "bar", "area"
- Use "line" for trends over time, "bar" for comparisons, "area" for cumulative/stacked data
- xKey is the field used for the x-axis
- lines is an array of series to plot, each with "key" (data field) and "label" (display name)
- data is the array of data points with values for xKey and all line keys
- You can include multiple lines/series for comparison charts
- Always include the chart spec AND a text explanation around it
- Compute the data from the dataset context — do not make up numbers
- Keep data points reasonable (5-15 points ideal)`;

// Simple markdown renderer for **bold** and *italic*
function renderMarkdown(text) {
  const parts = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Bold: **text**
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
    if (boldMatch) {
      const idx = boldMatch.index;
      if (idx > 0) {
        parts.push(<span key={key++}>{remaining.slice(0, idx)}</span>);
      }
      parts.push(
        <span key={key++} style={{ color: "#e2e4ed", fontWeight: 600 }}>
          {boldMatch[1]}
        </span>
      );
      remaining = remaining.slice(idx + boldMatch[0].length);
    } else {
      parts.push(<span key={key++}>{remaining}</span>);
      break;
    }
  }

  return parts;
}

// Parse chat response into text blocks and chart blocks
function parseChatResponse(content) {
  const blocks = [];
  let remaining = content;

  while (remaining.length > 0) {
    const chartStart = remaining.indexOf("|||CHART|||");
    if (chartStart === -1) {
      if (remaining.trim()) blocks.push({ type: "text", content: remaining.trim() });
      break;
    }

    // Text before chart
    const textBefore = remaining.slice(0, chartStart).trim();
    if (textBefore) blocks.push({ type: "text", content: textBefore });

    const chartEnd = remaining.indexOf("|||ENDCHART|||", chartStart);
    if (chartEnd === -1) {
      blocks.push({ type: "text", content: remaining.slice(chartStart).trim() });
      break;
    }

    const chartJson = remaining.slice(chartStart + 11, chartEnd).trim();
    try {
      const clean = chartJson.replace(/```json|```/g, "").trim();
      const chartData = JSON.parse(clean);
      blocks.push({ type: "chart", content: chartData });
    } catch (e) {
      blocks.push({ type: "text", content: "[Chart failed to render]" });
    }

    remaining = remaining.slice(chartEnd + 14);
  }

  return blocks;
}

// Chart renderer
function ChartBlock({ spec }) {
  const { type, title, xKey, lines, data } = spec;

  if (!data || !data.length || !lines || !lines.length) {
    return <div style={{ color: "#6b7089", fontSize: 13 }}>[No chart data]</div>;
  }

  const ChartComponent = type === "line" ? LineChart : type === "area" ? AreaChart : BarChart;
  const DataComponent = type === "line" ? Line : type === "area" ? Area : Bar;

  return (
    <div style={{
      background: "#0d0e14",
      border: "1px solid #1e2030",
      borderRadius: 10,
      padding: "16px 12px 8px 0",
      margin: "12px 0",
    }}>
      {title && (
        <div style={{
          fontSize: 12, fontWeight: 600, color: "#6b7089",
          letterSpacing: "0.04em", textTransform: "uppercase",
          marginBottom: 12, paddingLeft: 16,
          fontFamily: "'DM Mono', monospace",
        }}>{title}</div>
      )}
      <ResponsiveContainer width="100%" height={240}>
        <ChartComponent data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e2030" />
          <XAxis
            dataKey={xKey}
            tick={{ fill: "#6b7089", fontSize: 11 }}
            axisLine={{ stroke: "#1e2030" }}
            tickLine={{ stroke: "#1e2030" }}
          />
          <YAxis
            tick={{ fill: "#6b7089", fontSize: 11 }}
            axisLine={{ stroke: "#1e2030" }}
            tickLine={{ stroke: "#1e2030" }}
          />
          <Tooltip
            contentStyle={{
              background: "#12131a",
              border: "1px solid #2a2b3a",
              borderRadius: 8,
              fontSize: 12,
              color: "#e2e4ed",
            }}
          />
          {lines.length > 1 && (
            <Legend
              wrapperStyle={{ fontSize: 11, color: "#6b7089" }}
            />
          )}
          {lines.map((line, i) => {
            const color = CHART_COLORS[i % CHART_COLORS.length];
            if (type === "bar") {
              return (
                <Bar
                  key={line.key}
                  dataKey={line.key}
                  name={line.label}
                  fill={color}
                  radius={[4, 4, 0, 0]}
                />
              );
            } else if (type === "area") {
              return (
                <Area
                  key={line.key}
                  type="monotone"
                  dataKey={line.key}
                  name={line.label}
                  stroke={color}
                  fill={color}
                  fillOpacity={0.15}
                  strokeWidth={2}
                />
              );
            } else {
              return (
                <Line
                  key={line.key}
                  type="monotone"
                  dataKey={line.key}
                  name={line.label}
                  stroke={color}
                  strokeWidth={2}
                  dot={{ fill: color, r: 3 }}
                  activeDot={{ r: 5 }}
                />
              );
            }
          })}
        </ChartComponent>
      </ResponsiveContainer>
    </div>
  );
}

// Render a chat message with markdown + inline charts
function ChatMessageContent({ content, role }) {
  if (role === "user") {
    return <span>{content}</span>;
  }

  const blocks = parseChatResponse(content);

  return (
    <div>
      {blocks.map((block, i) => {
        if (block.type === "chart") {
          return <ChartBlock key={i} spec={block.content} />;
        }
        // Text block: split by newlines and render markdown
        return (
          <div key={i} style={{ whiteSpace: "pre-wrap" }}>
            {block.content.split("\n").map((line, li) => (
              <span key={li}>
                {renderMarkdown(line)}
                {li < block.content.split("\n").length - 1 && <br />}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export default function App() {
  const [stage, setStage] = useState("upload");
  const [fileName, setFileName] = useState("");
  const [parsedData, setParsedData] = useState(null);
  const [columns, setColumns] = useState([]);
  const [rowCount, setRowCount] = useState(0);
  const [objective, setObjective] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [showApiInput, setShowApiInput] = useState(false);
  const fileInputRef = useRef(null);

  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef(null);
  const chatInputRef = useRef(null);

  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [chatMessages, chatLoading]);

  const parseFile = useCallback((file) => {
    setError(null);
    setFileName(file.name);

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        let data;
        if (file.name.endsWith(".csv") || file.name.endsWith(".tsv")) {
          const text = e.target.result;
          const wb = XLSX.read(text, { type: "string" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          data = XLSX.utils.sheet_to_json(ws, { defval: "" });
        } else {
          const arrayBuffer = e.target.result;
          const wb = XLSX.read(arrayBuffer, { type: "array" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          data = XLSX.utils.sheet_to_json(ws, { defval: "" });
        }

        if (!data || data.length === 0) {
          setError("No data found in file.");
          return;
        }

        const cols = Object.keys(data[0]);
        setColumns(cols);
        setRowCount(data.length);
        setParsedData(data);
        setStage("preview");
      } catch (err) {
        setError("Failed to parse file: " + err.message);
      }
    };

    if (file.name.endsWith(".csv") || file.name.endsWith(".tsv")) {
      reader.readAsText(file);
    } else {
      reader.readAsArrayBuffer(file);
    }
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) parseFile(file);
  }, [parseFile]);

  const handleFileSelect = useCallback((e) => {
    const file = e.target.files[0];
    if (file) parseFile(file);
  }, [parseFile]);

  const getApiKey = () => {
    return apiKey || import.meta.env.VITE_ANTHROPIC_API_KEY || "";
  };

  const buildDataContext = () => {
    if (!parsedData || !analysis) return "";

    const numericCols = columns.filter((col) =>
      parsedData.some((row) => typeof row[col] === "number")
    );
    const colSummary = numericCols.map((col) => {
      const vals = parsedData.map((r) => r[col]).filter((v) => typeof v === "number");
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const avg = (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2);
      return `${col}: min=${min}, max=${max}, avg=${avg}`;
    }).join("\n");

    const catCols = columns.filter((col) =>
      parsedData.every((row) => typeof row[col] === "string" || typeof row[col] === "undefined")
    );
    const catSummary = catCols.map((col) => {
      const uniq = [...new Set(parsedData.map((r) => r[col]).filter(Boolean))];
      return `${col}: [${uniq.slice(0, 15).join(", ")}]${uniq.length > 15 ? ` +${uniq.length - 15} more` : ""}`;
    }).join("\n");

    const sampleRows = [
      ...parsedData.slice(0, 10),
      ...parsedData.slice(-5),
    ];

    return `DATASET CONTEXT:
File: ${fileName} (${rowCount} rows, ${columns.length} columns)
Columns: ${columns.join(", ")}

NUMERIC SUMMARY:
${colSummary}

CATEGORICAL VALUES:
${catSummary}

SAMPLE ROWS (first 10 + last 5):
${JSON.stringify(sampleRows, null, 2)}

INITIAL ANALYSIS SUMMARY:
${analysis.summary}

KEY FINDINGS:
${analysis.trends.map((t) => `- [TREND/${t.severity}] ${t.title}: ${t.detail}`).join("\n")}
${analysis.anomalies.map((a) => `- [ANOMALY/${a.severity}] ${a.title}: ${a.detail}`).join("\n")}
${analysis.investigation_flags.map((f) => `- [FLAG/${f.severity}] ${f.title}: ${f.detail}`).join("\n")}

ORIGINAL OBJECTIVE: ${objective}`;
  };

  const runAnalysis = async () => {
    const key = getApiKey();
    if (!key) {
      setShowApiInput(true);
      setError("API key required. Set VITE_ANTHROPIC_API_KEY in .env or enter below.");
      return;
    }

    setStage("analyzing");
    setError(null);

    const dataSlice = parsedData.slice(0, 500);
    const dataStr = JSON.stringify(dataSlice, null, 2);

    const userMessage = `OBJECTIVE: ${objective}

DATASET: ${fileName}
ROWS: ${rowCount} (showing first ${dataSlice.length})
COLUMNS: ${columns.join(", ")}

DATA:
${dataStr}`;

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4000,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMessage }],
        }),
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`API error ${response.status}: ${errBody}`);
      }

      const result = await response.json();
      const text = result.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");

      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      setAnalysis(parsed);
      setChatMessages([]);
      setStage("results");
    } catch (err) {
      setError("Analysis failed: " + err.message);
      setStage("objective");
    }
  };

  const sendChatMessage = async () => {
    const msg = chatInput.trim();
    if (!msg || chatLoading) return;

    const key = getApiKey();
    if (!key) {
      setError("API key required.");
      return;
    }

    const newUserMsg = { role: "user", content: msg };
    const updatedMessages = [...chatMessages, newUserMsg];
    setChatMessages(updatedMessages);
    setChatInput("");
    setChatLoading(true);

    // Reset textarea height
    if (chatInputRef.current) {
      chatInputRef.current.style.height = "auto";
    }

    const dataContext = buildDataContext();
    const apiMessages = [
      { role: "user", content: `Here is the dataset context and initial analysis for reference:\n\n${dataContext}` },
      { role: "assistant", content: "Understood. I have the full dataset context and initial analysis loaded. Ready for your follow-up questions." },
      ...updatedMessages,
    ];

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 3000,
          system: CHAT_SYSTEM_PROMPT,
          messages: apiMessages,
        }),
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`API error ${response.status}: ${errBody}`);
      }

      const result = await response.json();
      const text = result.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");

      setChatMessages([...updatedMessages, { role: "assistant", content: text }]);
    } catch (err) {
      setChatMessages([
        ...updatedMessages,
        { role: "assistant", content: `Error: ${err.message}` },
      ]);
    } finally {
      setChatLoading(false);
    }
  };

  const handleChatKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  };

  const resetAll = () => {
    setStage("upload");
    setFileName("");
    setParsedData(null);
    setColumns([]);
    setRowCount(0);
    setObjective("");
    setAnalysis(null);
    setError(null);
    setChatMessages([]);
    setChatInput("");
  };

  return (
    <div style={{
      minHeight: "100vh",
      background: "#07080c",
      color: "#e2e4ed",
      fontFamily: "'DM Sans', 'Helvetica Neue', sans-serif",
    }}>
      {/* Header */}
      <div style={{
        padding: "24px 32px",
        borderBottom: "1px solid #1a1b26",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{
            width: 32, height: 32,
            background: "linear-gradient(135deg, #4f8ffa 0%, #a78bfa 100%)",
            borderRadius: 8,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 16, fontWeight: 700,
          }}>T</div>
          <span style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-0.02em" }}>TrendReader</span>
          <span style={{ fontSize: 12, color: "#6b7089", marginLeft: 4, fontFamily: "'DM Mono', monospace" }}>v0.3</span>
        </div>
        {stage !== "upload" && (
          <button onClick={resetAll} style={{
            background: "transparent", border: "1px solid #2a2b3a", color: "#6b7089",
            padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13,
          }}>New Analysis</button>
        )}
      </div>

      <div style={{ maxWidth: 960, margin: "0 auto", padding: "40px 24px" }}>

        {/* Upload */}
        {stage === "upload" && (
          <div style={{ textAlign: "center" }}>
            <h1 style={{ fontSize: 36, fontWeight: 300, letterSpacing: "-0.03em", marginBottom: 8 }}>
              Drop your data. State your objective.
            </h1>
            <p style={{ color: "#6b7089", fontSize: 15, marginBottom: 48 }}>
              Upload an Excel or CSV file and tell the engine what you're trying to understand.
            </p>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              style={{
                border: `2px dashed ${dragOver ? "#4f8ffa" : "#2a2b3a"}`,
                borderRadius: 16, padding: "80px 40px", cursor: "pointer",
                transition: "all 0.2s ease",
                background: dragOver ? "rgba(79,143,250,0.04)" : "transparent",
              }}
            >
              <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.4 }}>↑</div>
              <p style={{ fontSize: 16, color: dragOver ? "#4f8ffa" : "#6b7089", marginBottom: 8 }}>
                Drop .xlsx, .xls, or .csv here
              </p>
              <p style={{ fontSize: 13, color: "#3d4058" }}>or click to browse</p>
              <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv,.tsv"
                onChange={handleFileSelect} style={{ display: "none" }} />
            </div>
          </div>
        )}

        {/* Preview */}
        {stage === "preview" && parsedData && (
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
              <div>
                <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>{fileName}</h2>
                <p style={{ color: "#6b7089", fontSize: 13, fontFamily: "'DM Mono', monospace" }}>
                  {rowCount} rows · {columns.length} columns
                </p>
              </div>
              <button onClick={() => setStage("objective")} style={{
                background: "linear-gradient(135deg, #4f8ffa, #6366f1)",
                border: "none", color: "#fff", padding: "10px 24px",
                borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 500,
              }}>Looks Good →</button>
            </div>
            <div style={{ border: "1px solid #1a1b26", borderRadius: 12, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr>
                      {columns.map((col, i) => (
                        <th key={i} style={{
                          padding: "10px 14px", textAlign: "left",
                          borderBottom: "1px solid #1a1b26", background: "#0d0e14",
                          color: "#6b7089", fontWeight: 500, whiteSpace: "nowrap",
                          fontFamily: "'DM Mono', monospace", fontSize: 12,
                        }}>{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {parsedData.slice(0, 15).map((row, ri) => (
                      <tr key={ri} style={{ borderBottom: "1px solid #12131a" }}>
                        {columns.map((col, ci) => (
                          <td key={ci} style={{
                            padding: "8px 14px", whiteSpace: "nowrap", color: "#c0c3d4", fontSize: 12,
                            fontFamily: typeof row[col] === "number" ? "'DM Mono', monospace" : "inherit",
                          }}>
                            {row[col] !== undefined && row[col] !== null ? String(row[col]) : "—"}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rowCount > 15 && (
                <div style={{
                  padding: "8px 14px", color: "#3d4058", fontSize: 12,
                  borderTop: "1px solid #1a1b26", textAlign: "center",
                  fontFamily: "'DM Mono', monospace",
                }}>+ {rowCount - 15} more rows</div>
              )}
            </div>
          </div>
        )}

        {/* Objective */}
        {stage === "objective" && (
          <div>
            <div style={{
              background: "#0d0e14", border: "1px solid #1a1b26",
              borderRadius: 10, padding: "12px 16px", marginBottom: 32,
              display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
            }}>
              <span style={{ fontSize: 13, color: "#4f8ffa", fontFamily: "'DM Mono', monospace" }}>FILE</span>
              <span style={{ fontSize: 13, color: "#6b7089" }}>{fileName}</span>
              <span style={{ fontSize: 12, color: "#3d4058", fontFamily: "'DM Mono', monospace" }}>
                {rowCount} rows · {columns.length} cols
              </span>
            </div>
            <h2 style={{ fontSize: 28, fontWeight: 300, letterSpacing: "-0.02em", marginBottom: 8 }}>
              What are you trying to understand?
            </h2>
            <p style={{ color: "#6b7089", fontSize: 14, marginBottom: 32 }}>
              Be specific. The more context you give, the sharper the analysis.
            </p>
            <textarea value={objective} onChange={(e) => setObjective(e.target.value)}
              placeholder="e.g. Why did subscription churn increase in Q1? Which cohorts are underperforming and what's driving it?"
              style={{
                width: "100%", minHeight: 120, padding: "16px",
                background: "#0d0e14", border: "1px solid #2a2b3a",
                borderRadius: 10, color: "#e2e4ed", fontSize: 15,
                fontFamily: "'DM Sans', sans-serif", resize: "vertical",
                lineHeight: 1.6, outline: "none", boxSizing: "border-box",
              }}
              onFocus={(e) => e.target.style.borderColor = "#4f8ffa"}
              onBlur={(e) => e.target.style.borderColor = "#2a2b3a"}
            />
            <div style={{ marginTop: 12, marginBottom: 32 }}>
              <p style={{ fontSize: 12, color: "#3d4058", marginBottom: 8 }}>Try:</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {[
                  "Find anomalies and explain what's driving them",
                  "Identify the top revenue risks in this data",
                  "What trends should I flag to leadership?",
                ].map((s, i) => (
                  <button key={i} onClick={() => setObjective(s)} style={{
                    background: "#12131a", border: "1px solid #1e2030",
                    color: "#6b7089", padding: "6px 12px", borderRadius: 6,
                    cursor: "pointer", fontSize: 12,
                  }}>{s}</button>
                ))}
              </div>
            </div>
            {showApiInput && (
              <div style={{ marginBottom: 20 }}>
                <label style={{ fontSize: 12, color: "#6b7089", display: "block", marginBottom: 6 }}>Anthropic API Key</label>
                <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-ant-..." style={{
                    width: "100%", padding: "10px 14px", background: "#0d0e14",
                    border: "1px solid #2a2b3a", borderRadius: 8, color: "#e2e4ed",
                    fontSize: 13, fontFamily: "'DM Mono', monospace", outline: "none", boxSizing: "border-box",
                  }} />
                <p style={{ fontSize: 11, color: "#3d4058", marginTop: 6 }}>Or set VITE_ANTHROPIC_API_KEY in your .env file</p>
              </div>
            )}
            <button onClick={runAnalysis} disabled={!objective.trim()} style={{
              background: objective.trim() ? "linear-gradient(135deg, #4f8ffa, #6366f1)" : "#1a1b26",
              border: "none", color: objective.trim() ? "#fff" : "#3d4058",
              padding: "12px 32px", borderRadius: 8,
              cursor: objective.trim() ? "pointer" : "not-allowed",
              fontSize: 15, fontWeight: 500, width: "100%",
            }}>Run Analysis →</button>
          </div>
        )}

        {/* Analyzing */}
        {stage === "analyzing" && (
          <div style={{ textAlign: "center", padding: "120px 0" }}>
            <div style={{
              width: 48, height: 48, margin: "0 auto 24px",
              border: "3px solid #1a1b26", borderTopColor: "#4f8ffa",
              borderRadius: "50%", animation: "spin 0.8s linear infinite",
            }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            <p style={{ fontSize: 16, color: "#6b7089", marginBottom: 8 }}>Analyzing {rowCount} rows...</p>
            <p style={{ fontSize: 13, color: "#3d4058" }}>Mapping data against your objective</p>
          </div>
        )}

        {/* Results */}
        {stage === "results" && analysis && (
          <div>
            {/* Summary */}
            <div style={{
              background: "linear-gradient(135deg, rgba(79,143,250,0.06), rgba(99,102,241,0.04))",
              border: "1px solid rgba(79,143,250,0.15)",
              borderRadius: 12, padding: "20px 24px", marginBottom: 32,
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#4f8ffa", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8, fontFamily: "'DM Mono', monospace" }}>
                Executive Summary
              </div>
              <p style={{ fontSize: 15, lineHeight: 1.7, color: "#c0c3d4", margin: 0 }}>{analysis.summary}</p>
            </div>

            {/* Meta */}
            <div style={{ display: "flex", gap: 16, marginBottom: 32, flexWrap: "wrap" }}>
              <div style={{ background: "#0d0e14", border: "1px solid #1a1b26", borderRadius: 8, padding: "8px 14px", fontSize: 12 }}>
                <span style={{ color: "#3d4058" }}>Source: </span>
                <span style={{ color: "#6b7089", fontFamily: "'DM Mono', monospace" }}>{fileName}</span>
              </div>
              <div style={{ background: "#0d0e14", border: "1px solid #1a1b26", borderRadius: 8, padding: "8px 14px", fontSize: 12 }}>
                <span style={{ color: "#3d4058" }}>Objective: </span>
                <span style={{ color: "#6b7089" }}>{objective.slice(0, 60)}{objective.length > 60 ? "..." : ""}</span>
              </div>
            </div>

            {/* Findings */}
            {[
              { key: "trends", label: "Trends", icon: "↗" },
              { key: "anomalies", label: "Anomalies", icon: "⚡" },
              { key: "investigation_flags", label: "Investigation Flags", icon: "🔍" },
            ].map(({ key, label, icon }) => (
              <div key={key} style={{ marginBottom: 40 }}>
                <h3 style={{
                  fontSize: 13, fontWeight: 600, color: "#6b7089",
                  letterSpacing: "0.08em", textTransform: "uppercase",
                  marginBottom: 16, fontFamily: "'DM Mono', monospace",
                }}>
                  {icon} {label}
                  <span style={{ marginLeft: 8, fontSize: 11, color: "#3d4058", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                    {analysis[key]?.length || 0} findings
                  </span>
                </h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {(analysis[key] || []).map((item, i) => {
                    const sc = SEVERITY_COLORS[item.severity] || SEVERITY_COLORS.low;
                    return (
                      <div key={i} style={{ background: sc.bg, border: `1px solid ${sc.border}`, borderRadius: 10, padding: "16px 20px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                          <span style={{
                            fontSize: 10, fontWeight: 600, textTransform: "uppercase",
                            letterSpacing: "0.08em", color: sc.badge,
                            background: `${sc.badge}18`, padding: "2px 8px",
                            borderRadius: 4, fontFamily: "'DM Mono', monospace",
                          }}>{item.severity}</span>
                          <span style={{ fontSize: 15, fontWeight: 500, color: "#e2e4ed" }}>{item.title}</span>
                        </div>
                        <p style={{ fontSize: 13, lineHeight: 1.65, color: "#9a9db5", margin: 0 }}>{item.detail}</p>
                        {item.relevant_columns && item.relevant_columns.length > 0 && (
                          <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
                            {item.relevant_columns.map((col, ci) => (
                              <span key={ci} style={{
                                fontSize: 11, color: "#4f8ffa",
                                background: "rgba(79,143,250,0.08)",
                                padding: "2px 8px", borderRadius: 4,
                                fontFamily: "'DM Mono', monospace",
                              }}>{col}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            {/* ==================== CHAT ==================== */}
            <div style={{ borderTop: "1px solid #1a1b26", marginTop: 20, paddingTop: 32 }}>
              <h3 style={{
                fontSize: 13, fontWeight: 600, color: "#6b7089",
                letterSpacing: "0.08em", textTransform: "uppercase",
                marginBottom: 20, fontFamily: "'DM Mono', monospace",
              }}>
                💬 Follow-up
                <span style={{ marginLeft: 8, fontSize: 11, color: "#3d4058", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                  drill in, ask "what if", request charts
                </span>
              </h3>

              {/* Messages */}
              {chatMessages.length > 0 && (
                <div style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 12 }}>
                  {chatMessages.map((msg, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start" }}>
                      <div style={{
                        maxWidth: msg.role === "user" ? "85%" : "95%",
                        padding: "12px 16px",
                        borderRadius: msg.role === "user" ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
                        background: msg.role === "user"
                          ? "linear-gradient(135deg, rgba(79,143,250,0.15), rgba(99,102,241,0.1))"
                          : "#12131a",
                        border: msg.role === "user"
                          ? "1px solid rgba(79,143,250,0.25)"
                          : "1px solid #1e2030",
                      }}>
                        {msg.role === "assistant" && (
                          <div style={{
                            fontSize: 10, fontWeight: 600, color: "#4f8ffa",
                            letterSpacing: "0.08em", textTransform: "uppercase",
                            marginBottom: 6, fontFamily: "'DM Mono', monospace",
                          }}>TrendReader</div>
                        )}
                        <div style={{
                          fontSize: 13, lineHeight: 1.7,
                          color: msg.role === "user" ? "#e2e4ed" : "#9a9db5",
                        }}>
                          <ChatMessageContent content={msg.content} role={msg.role} />
                        </div>
                      </div>
                    </div>
                  ))}

                  {chatLoading && (
                    <div style={{ display: "flex", justifyContent: "flex-start" }}>
                      <div style={{
                        padding: "12px 16px", borderRadius: "12px 12px 12px 4px",
                        background: "#12131a", border: "1px solid #1e2030",
                      }}>
                        <div style={{
                          fontSize: 10, fontWeight: 600, color: "#4f8ffa",
                          letterSpacing: "0.08em", textTransform: "uppercase",
                          marginBottom: 6, fontFamily: "'DM Mono', monospace",
                        }}>TrendReader</div>
                        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                          {[0, 1, 2].map((d) => (
                            <div key={d} style={{
                              width: 6, height: 6, borderRadius: "50%", background: "#4f8ffa",
                              animation: `pulse 1.2s ease-in-out ${d * 0.2}s infinite`,
                            }} />
                          ))}
                        </div>
                        <style>{`@keyframes pulse { 0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); } 40% { opacity: 1; transform: scale(1); } }`}</style>
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>
              )}

              {/* Suggestion chips */}
              {chatMessages.length === 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
                  {[
                    "Drill into EMEA performance",
                    "What if we cut Pod 4 pricing by 15%?",
                    "Chart churn rate by geo over time",
                    "Compare DTC vs Retail unit economics",
                    "Show me MRR trend as a line chart",
                  ].map((s, i) => (
                    <button key={i} onClick={() => { setChatInput(s); chatInputRef.current?.focus(); }} style={{
                      background: "#0d0e14", border: "1px solid #1e2030",
                      color: "#6b7089", padding: "6px 12px", borderRadius: 6,
                      cursor: "pointer", fontSize: 12, transition: "all 0.15s ease",
                    }}
                    onMouseEnter={(e) => { e.target.style.borderColor = "#4f8ffa"; e.target.style.color = "#e2e4ed"; }}
                    onMouseLeave={(e) => { e.target.style.borderColor = "#1e2030"; e.target.style.color = "#6b7089"; }}
                    >{s}</button>
                  ))}
                </div>
              )}

              {/* Input */}
              <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
                <textarea
                  ref={chatInputRef}
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={handleChatKeyDown}
                  placeholder="Ask a follow-up or request a chart..."
                  rows={1}
                  style={{
                    flex: 1, padding: "12px 16px",
                    background: "#0d0e14", border: "1px solid #2a2b3a",
                    borderRadius: 10, color: "#e2e4ed", fontSize: 14,
                    fontFamily: "'DM Sans', sans-serif",
                    lineHeight: 1.5, outline: "none", resize: "none",
                    minHeight: 44, maxHeight: 120,
                  }}
                  onFocus={(e) => e.target.style.borderColor = "#4f8ffa"}
                  onBlur={(e) => e.target.style.borderColor = "#2a2b3a"}
                  onInput={(e) => {
                    e.target.style.height = "auto";
                    e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
                  }}
                />
                <button onClick={sendChatMessage} disabled={!chatInput.trim() || chatLoading} style={{
                  padding: "12px 20px",
                  background: chatInput.trim() && !chatLoading
                    ? "linear-gradient(135deg, #4f8ffa, #6366f1)" : "#1a1b26",
                  border: "none",
                  color: chatInput.trim() && !chatLoading ? "#fff" : "#3d4058",
                  borderRadius: 10,
                  cursor: chatInput.trim() && !chatLoading ? "pointer" : "not-allowed",
                  fontSize: 14, fontWeight: 500, minHeight: 44, whiteSpace: "nowrap",
                }}>Send →</button>
              </div>
              <p style={{ fontSize: 11, color: "#3d4058", marginTop: 8 }}>Enter to send · Shift+Enter for new line · Try "chart churn by geo"</p>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{
            background: "#1a0f0f", border: "1px solid #7f1d1d",
            borderRadius: 10, padding: "14px 18px", marginTop: 20, color: "#fca5a5", fontSize: 13,
          }}>{error}</div>
        )}
      </div>
    </div>
  );
}