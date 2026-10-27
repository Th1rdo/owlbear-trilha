/** Pasted links → track sources. Pure, so it can be tested without a browser. */

export const isLink = (src: string) => src.startsWith("yt:") || /^https?:\/\//.test(src);

/** A pasted link as a track `src` ("yt:<id>" or the playable URL) and a first name for it. */
export function parseLink(raw: string): { src: string; name: string } | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  let yt: string | null = null;
  if (host === "youtu.be") yt = url.pathname.slice(1);
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    yt = url.searchParams.get("v") ?? url.pathname.match(/^\/(?:embed|shorts|live)\/([^/?]+)/)?.[1] ?? null;
  }
  if (yt) return /^[\w-]{11}$/.test(yt) ? { src: `yt:${yt}`, name: `YouTube ${yt}` } : null;
  if (!/^https?:$/.test(url.protocol)) return null;
  // Share pages → the file itself.
  if (host === "dropbox.com") {
    url.searchParams.delete("dl");
    url.searchParams.set("raw", "1");
  }
  const drive = host === "drive.google.com" && (url.pathname.match(/\/file\/d\/([^/]+)/)?.[1] ?? url.searchParams.get("id"));
  if (drive) url = new URL(`https://drive.google.com/uc?export=download&id=${drive}`);
  const file = decodeURIComponent(url.pathname.split("/").pop() ?? "").replace(/\.[^.]+$/, "");
  return { src: url.toString(), name: file || host };
}
