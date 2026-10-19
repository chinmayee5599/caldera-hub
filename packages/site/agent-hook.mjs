#!/usr/bin/env node
// Caldera agent hook: tells your Caldera city what this AI agent is working on, so it shows up as a drone over the
// repo it's in. Claude Code runs it on UserPromptSubmit, PostToolUse, Stop, Notification and SessionEnd.
// Sends only: a session id, this machine's name, the repo name, a state, a short task title (your prompt's first line,
// with keys / emails / long numbers stripped) and the last tool step. Never blocks: 1.5s timeout, always exits 0.
// Config: ~/.caldera/agent.json  {"hub": "https://caldera.social", "key": "...", "secret": "...", "machine": "laptop"}
// Add "tasks": false to send no task title or tool step at all (the drone still flies, just without words).
// It never reads your code or sends file contents, and it gives Caldera no access to your repos or this computer.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { execFileSync } from "node:child_process";

const DIR = path.join(os.homedir(), ".caldera"), STATE = path.join(DIR, "agent-state.json");
const done = () => process.exit(0);
setTimeout(done, 2500).unref();

const redact = t => String(t || "")
  .replace(/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g, "[key]").replace(/\b(ghp|gho|github_pat|xox[abp]|AIza)[A-Za-z0-9_-]{16,}/gi, "[key]").replace(/AKIA[0-9A-Z]{16}/g, "[key]")
  .replace(/\b(password|passwd|pw|pass|secret|token)\b(\s*[:=]\s*|\s+is\s+)\S+/gi, "$1 [redacted]")
  .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]").replace(/\b[0-9a-f]{24,}\b/gi, "[id]").replace(/\b(?:\d[ -]?){9,}\b/g, "[number]");

function repoOf(dir) {
  try {
    const top = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 800, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!top || path.resolve(top) === os.homedir()) return "";
    let url = ""; try { url = execFileSync("git", ["-C", top, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 800, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
    return url ? url.replace(/\/$/, "").split(/[/:]/).pop().replace(/\.git$/, "") : path.basename(top);
  } catch { return ""; }
}

const ASK = /(want me to|should i|shall i|do you want|would you like|let me know|which (one|option|do you)|can you (confirm|run|send|approve|paste|check)|needs? (you|your)|waiting (on|for) you|your call|approve|ok to|okay to)/i;
function asks(text) { const paras = String(text || "").trim().slice(-500).split(/\n\s*\n/).filter(p => p.trim()); const last = paras[paras.length - 1] || ""; return last.includes("?") || ASK.test(last); }
function lastReply(file) {   // the last assistant text in the session transcript (reads only its tail)
  try {
    const fd = fs.openSync(file, "r"), size = fs.fstatSync(fd).size, n = Math.min(size, 400_000), buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n); fs.closeSync(fd);
    for (const ln of buf.toString("utf8").split("\n").reverse()) {
      try { const e = JSON.parse(ln); const c = e.type === "assistant" && e.message?.content;
        if (Array.isArray(c)) { const t = c.filter(x => x.type === "text").map(x => x.text).join("\n"); if (t.trim()) return t; } } catch {}
    }
  } catch {}
  return "";
}

let input = "";
process.stdin.on("data", c => { input += c; if (input.length > 2e6) done(); });
process.stdin.on("end", async () => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(DIR, "agent.json"), "utf8"));
    const ev = JSON.parse(input || "{}"), sid = String(ev.session_id || "").slice(0, 36);
    if (!cfg.key || !cfg.secret || !sid) return done();
    let st = {}; try { st = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch {}
    const me = st[sid] || (st[sid] = { task: "", repo: "", sent: 0, state: "" });
    let state = "working", did = "";
    switch (ev.hook_event_name) {
      case "UserPromptSubmit": {
        const first = String(ev.prompt || "").split("\n").find(l => l.trim()) || "";
        if (first.split(/\s+/).length >= 4 || !me.task) me.task = redact(first).trim().slice(0, 80);
        state = "thinking"; break;
      }
      case "PostToolUse": {
        const inp = ev.tool_input || {}, target = inp.file_path || inp.path || inp.description || "";
        did = redact(`${ev.tool_name || "Tool"}${target ? " " + (String(target).includes("/") ? path.basename(String(target)) : String(target)) : ""}`).slice(0, 80);
        const f = inp.file_path || inp.path; if (f && path.isAbsolute(String(f))) { const r = repoOf(path.dirname(String(f))); if (r) me.repo = r; }
        break;
      }
      // "waiting" only when the agent actually asks you something or needs a permission; a finished turn is "done"
      case "Stop": state = asks(lastReply(ev.transcript_path)) ? "waiting" : "done"; break;
      case "Notification": if (!/permission|approve|needs your/i.test(String(ev.message || ""))) { fs.writeFileSync(STATE, JSON.stringify(st)); return done(); } state = "waiting"; break;
      case "SessionEnd": state = "gone"; break;
    }
    if (!me.repo && ev.cwd) me.repo = repoOf(ev.cwd);
    // PostToolUse fires a lot: send at most every 5s unless the state changed
    const now = Date.now();
    if (state === me.state && state === "working" && now - me.sent < 5000) { fs.writeFileSync(STATE, JSON.stringify(st)); return done(); }
    me.state = state; me.sent = now;
    if (state === "gone") delete st[sid];
    for (const k of Object.keys(st)) if (now - (st[k].sent || 0) > 86400_000) delete st[k];
    fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(st), { mode: 0o600 });
    if (cfg.tasks === false) { me.task = ""; did = ""; }
    const machine = String(cfg.machine || os.hostname().split(".")[0]).slice(0, 40);
    await fetch(`${String(cfg.hub || "https://caldera.social").replace(/\/$/, "")}/v1/agents/${cfg.key}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + cfg.secret }, signal: AbortSignal.timeout(1500),
      body: JSON.stringify({ agents: [{ id: sid, label: `Claude · ${machine}`, machine, repo: me.repo, state, task: me.task, did }] }),
    }).catch(() => {});
  } catch {}
  done();
});
