/**
 * A stand-in for the Owlbear SDK, for testing outside Owlbear: tabs of the same browser are the
 * "players" (?role=GM or ?role=PLAYER), and broadcast messages travel over a BroadcastChannel.
 */
type Fn = (...a: any[]) => void;
const id = crypto.randomUUID().slice(0, 6);
const role = new URLSearchParams(location.search).get("role") ?? "GM";
const bc = new BroadcastChannel("fake-obr");
const handlers = new Map<string, Set<Fn>>();
// Room metadata outlives a reload, as in Owlbear (kept in localStorage, shared by the tabs).
const metadata: Record<string, unknown> = JSON.parse(localStorage.getItem("fake-obr-meta") ?? "{}");
const persist = () => localStorage.setItem("fake-obr-meta", JSON.stringify(metadata));
const metaListeners = new Set<Fn>();
const deliver = (channel: string, data: unknown, from: string) =>
  handlers.get(channel)?.forEach(h => h({ data: structuredClone(data), connectionId: from }));
const seen = new Map<string, { role: string; at: number }>();
const partyListeners = new Set<Fn>();
const party = () => [...seen].map(([connectionId, v]) => ({ connectionId, role: v.role, id: connectionId, name: connectionId }));
setInterval(() => {
  bc.postMessage({ kind: "presence", id, role });
  const before = seen.size;
  for (const [k, v] of seen) if (Date.now() - v.at > 3000) seen.delete(k);
  if (seen.size !== before) partyListeners.forEach(f => f(party()));
}, 1000);
bc.onmessage = e => {
  const m = e.data;
  if (m.kind === "presence") {
    const isNew = !seen.has(m.id);
    seen.set(m.id, { role: m.role, at: Date.now() });
    if (isNew) partyListeners.forEach(f => f(party()));
  }
  if (m.kind === "msg" && m.from !== id) deliver(m.channel, m.data, m.from);
  if (m.kind === "meta") {
    Object.assign(metadata, m.update);
    for (const [k, v] of Object.entries(m.update)) if (v === undefined) delete metadata[k];
    metaListeners.forEach(f => f({ ...metadata }));
  }
};
const theme = {
  mode: "DARK", primary: { main: "#bb99ff", contrastText: "#000" }, secondary: { main: "#ee99ff", contrastText: "#000" },
  background: { default: "#1e2231", paper: "#3d4051" }, text: { primary: "#fff", secondary: "rgba(255,255,255,.7)", disabled: "rgba(255,255,255,.5)" },
};
const OBR = {
  onReady: (cb: Fn) => setTimeout(cb, 0),
  room: {
    id: "test-room",
    getMetadata: async () => ({ ...metadata }),
    setMetadata: async (update: Record<string, unknown>) => {
      Object.assign(metadata, update);
      for (const [k, v] of Object.entries(update)) if (v === undefined) delete metadata[k];
      persist();
      bc.postMessage({ kind: "meta", update });
      metaListeners.forEach(f => f({ ...metadata }));
    },
    onMetadataChange: (f: Fn) => (metaListeners.add(f), () => metaListeners.delete(f)),
  },
  player: { getConnectionId: async () => id, getRole: async () => role, onChange: () => () => {} },
  party: {
    getPlayers: async () => party(),
    onChange: (f: Fn) => (partyListeners.add(f), () => partyListeners.delete(f)),
  },
  broadcast: {
    sendMessage: async (channel: string, data: unknown, opts?: { destination?: string }) => {
      if (opts?.destination === "LOCAL") return deliver(channel, data, id);
      bc.postMessage({ kind: "msg", channel, data, from: id });
    },
    onMessage: (channel: string, f: Fn) => {
      if (!handlers.has(channel)) handlers.set(channel, new Set());
      handlers.get(channel)!.add(f);
      return () => handlers.get(channel)!.delete(f);
    },
  },
  action: { setBadgeText: async (t?: string) => console.log("[badge]", t) },
  notification: { show: async (m: string, v?: string) => console.log(`[notice ${v}]`, m) },
  theme: { getTheme: async () => theme, onChange: () => () => {} },
};
export default OBR;
export type Theme = typeof theme;

// Keep every peer connection reachable from the console (globalThis.__pcs) for the tests.
const Native = globalThis.RTCPeerConnection;
const pcs: RTCPeerConnection[] = [];
Object.assign(globalThis, { __pcs: pcs });
globalThis.RTCPeerConnection = class extends Native {
  constructor(c?: RTCConfiguration) {
    super(c);
    pcs.push(this);
  }
} as typeof RTCPeerConnection;
