/**
 * The setup guide: a direct message from the founder that walks each new member through what's still missing on their
 * page, instead of a checklist crowding the site. One welcome message ~30 minutes after signup (the page has built by
 * then), then at most two short follow-ups (day 3 and day 8) naming the single next step, and only while something
 * that matters is still missing. Replies land in the founder's inbox like any DM; the DM email digest carries it to
 * anyone who has email on. Existing members get the welcome once through the operator backfill.
 */
export interface GuideState {
  hosted: boolean;             // GitHub sign-up with no Obsidian vault connected yet
  missingBasics: string[];     // "photo", "headline", "links" ... in checklist order
  richer: boolean;             // vault page already has a journal / topics (the "richer page" prompt has been run)
  agents: boolean; live: boolean; email: boolean;
  grouped: boolean;            // has posted in a group
}
export interface GuideCtx {
  q: (sql: string) => any; now: () => string; hub: string;
  founder: () => string | null;
  send: (from: string, to: string, text: string) => boolean;
  stateOf: (member: string) => GuideState | null;
  nameOf: (member: string) => string;
}

const DAY = 86_400_000;
const BASIC_LABEL: Record<string, string> = { photo: "a photo", banner: "a masthead", headline: "a headline", summary: "two lines about you", links: "your links" };

interface Step { id: string; title: string; text: string }

/** Everything still worth doing, most valuable first. */
export function guideSteps(s: GuideState, hub: string): Step[] {
  const out: Step[] = [];
  if (s.hosted) out.push({ id: "obsidian", title: "Connect Obsidian",
    text: `This is what makes a page rich: your notes, a daily journal and your AI usage. Install the plugin (https://community.obsidian.md/plugins/caldera), then open ${hub}/settings#connections and tap Connect next to Obsidian for a one-time code.` });
  const basics = s.missingBasics.filter(b => BASIC_LABEL[b]).map(b => BASIC_LABEL[b]);
  if (basics.length) out.push({ id: "basics", title: "Finish the basics",
    text: `Add ${basics.length > 1 ? basics.slice(0, -1).join(", ") + " and " + basics[basics.length - 1] : basics[0]}: ${hub}/settings#finish` });
  if (!s.hosted && !s.richer) out.push({ id: "richer", title: "Let your AI fill your page",
    text: `Copy the "richer page" prompt (${hub}/guide#upgrade-prompt) into Claude or ChatGPT. It sets up your journal, topics, projects and AI usage, and shows you every change first.` });
  if (!s.agents || !s.live) out.push({ id: "power", title: "Bring your city to life",
    text: `Your coding agents as drones over your repos, and live visitors from your sites. One prompt does both: ${hub}/world#power-up` });
  if (!s.email) out.push({ id: "email", title: "Turn on the daily email",
    text: `So you hear when someone visits, follows or messages you: ${hub}/settings` });
  return out;
}

export function welcomeText(first: string, s: GuideState, hub: string, early = false): string {
  const steps = guideSteps(s, hub).slice(0, 4);
  const list = steps.map((st, i) => `${i + 1}. ${st.title}. ${st.text}`).join("\n\n");
  return `Hey ${first}, Mike here. I built Caldera. ${early ? "Thanks for being one of the first people on it!" : "Welcome!"}\n\n`
    + (steps.length ? `Here's your setup guide, just the things still missing on your page:\n\n${list}\n\n` : `Your page is in great shape already.\n\n`)
    + (s.grouped ? "" : `And come say hi in Feedback on Caldera: ${hub}/messages/groups/feedback-on-caldera\n\n`)
    + `Stuck on anything? Reply here. I read every message.`;
}

export function nudgeText(first: string, s: GuideState, hub: string, last: boolean): string | null {
  const st = guideSteps(s, hub).filter(x => x.id !== "email")[0];
  if (!st) return null;
  return `Hey ${first}, one next step for your page: ${st.title.toLowerCase()}.\n\n${st.text}\n\n`
    + (last ? `That's my last nudge. Reply anytime if you want a hand.` : `Takes a few minutes. Reply if anything's confusing.`);
}

export function setupGuide(c: GuideCtx) {
  const q = c.q;
  q(`CREATE TABLE IF NOT EXISTS setup_guide (member TEXT PRIMARY KEY, sent1 TEXT, sent2 TEXT, sent3 TEXT)`).run();
  const since = () => { let v = (q("SELECT v FROM hub_meta WHERE k='setup_guide_since'").get() as any)?.v;
    if (!v) { v = c.now(); q("INSERT OR IGNORE INTO hub_meta VALUES ('setup_guide_since', ?)").run(v); } return v as string; };
  since();   // the guide goes live now: later sign-ups get the welcome on their own, earlier ones through the backfill
  const first = (id: string) => (c.nameOf(id).trim().split(/\s+/)[0] || "there").slice(0, 40);

  function welcome(id: string, founder: string, early = false): boolean {
    const s = c.stateOf(id); if (!s) return false;
    if (!c.send(founder, id, welcomeText(first(id), s, c.hub, early))) return false;
    q("INSERT INTO setup_guide (member, sent1) VALUES (?,?) ON CONFLICT(member) DO UPDATE SET sent1=excluded.sent1").run(id, c.now());
    return true;
  }

  /** Every few minutes: welcome new members (joined since the guide went live, at least 30 minutes ago), and send the
   *  day-3 and day-8 follow-ups to anyone who still has a step left. Returns what it sent. */
  function tick(now = Date.now()) {
    const founder = c.founder(); if (!founder) return { welcomed: 0, nudged: 0 };
    let welcomed = 0, nudged = 0;
    const cut = new Date(now - 30 * 60_000).toISOString();
    for (const r of q("SELECT p.id FROM profiles p LEFT JOIN setup_guide g ON g.member=p.id WHERE p.handle IS NOT NULL AND p.id<>? AND g.member IS NULL AND p.created > ? AND p.created < ?").all(founder, since(), cut) as any[])
      if (welcome(r.id, founder)) welcomed++;
    for (const r of q("SELECT * FROM setup_guide WHERE sent1 IS NOT NULL AND sent3 IS NULL").all() as any[]) {
      const col = r.sent2 ? "sent3" : "sent2", from = Date.parse(r.sent2 || r.sent1), wait = r.sent2 ? 5 * DAY : 3 * DAY;
      if (now - from < wait) continue;
      const s = c.stateOf(r.member);
      const text = s ? nudgeText(first(r.member), s, c.hub, col === "sent3") : null;
      // nothing left (or the member is gone): close it out quietly
      if (!text) { q(`UPDATE setup_guide SET sent2=COALESCE(sent2,?), sent3=? WHERE member=?`).run(c.now(), c.now(), r.member); continue; }
      if (c.send(founder, r.member, text)) nudged++;
      q(`UPDATE setup_guide SET ${col}=? WHERE member=?`).run(c.now(), r.member);
    }
    return { welcomed, nudged };
  }

  /** Operator: the welcome for members who joined before the guide existed. `dry` lists who would get it. */
  function backfill(dry = false) {
    const founder = c.founder(); if (!founder) return [];
    const rows = q("SELECT p.id, p.handle FROM profiles p LEFT JOIN setup_guide g ON g.member=p.id WHERE p.handle IS NOT NULL AND p.id<>? AND g.member IS NULL ORDER BY p.created").all(founder) as any[];
    const out: { handle: string; sent: boolean; preview?: string }[] = [];
    for (const r of rows) {
      const s = c.stateOf(r.id); if (!s) continue;
      if (dry) { out.push({ handle: r.handle, sent: false, preview: welcomeText(first(r.id), s, c.hub, true) }); continue; }
      out.push({ handle: r.handle, sent: welcome(r.id, founder, true) });
    }
    return out;
  }
  const erase = (id: string) => { q("DELETE FROM setup_guide WHERE member=?").run(id); };
  return { tick, backfill, erase };
}
