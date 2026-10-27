import { emptyLibrary, type Library } from "./logic.ts";

/**
 * The GM's library, kept in this browser: the playlists (one JSON record) and the audio files
 * themselves (blobs). It belongs to the browser, not the room, so the same music follows the GM
 * into every room opened on this computer.
 */
const DB = "trilha";
const FILES = "files";
const META = "meta";

let opening: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(FILES);
      req.result.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opening;
}

async function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadLibrary(): Promise<Library> {
  const lib = ((await run(META, "readonly", s => s.get("library"))) ?? emptyLibrary()) as Library;
  lib.playlists ??= [];
  lib.entrada ??= 75;
  return lib;
}

export const saveLibrary = (lib: Library) => run(META, "readwrite", s => s.put(lib, "library")).then(() => undefined);

const AUDIO_EXT = /\.(mp3|wav|ogg|oga|opus|flac|m4a|aac|webm)$/i;
export const ACCEPT = ".mp3,.wav,.ogg,.oga,.opus,.flac,.m4a,.aac,.webm,audio/*";
export const isAudio = (f: File) => f.type.startsWith("audio/") || AUDIO_EXT.test(f.name);

/** Copies a file from the computer into the library; returns the track `src` ("local:<id>"). */
export async function addFile(file: File): Promise<string> {
  const id = crypto.randomUUID();
  await run(FILES, "readwrite", s => s.put(file, id));
  return `local:${id}`;
}

export async function deleteFile(src: string): Promise<void> {
  if (src.startsWith("local:")) await run(FILES, "readwrite", s => s.delete(src.slice(6)));
}

const urls = new Map<string, Promise<string>>();
/** A playable URL for a track's `src`: a blob URL for a stored file, or the link itself. */
export function urlFor(src: string): Promise<string> {
  if (!src.startsWith("local:")) return Promise.resolve(src);
  let p = urls.get(src);
  if (!p) {
    p = run<Blob | undefined>(FILES, "readonly", s => s.get(src.slice(6))).then(blob => {
      if (!blob) throw new Error("file missing from this browser");
      return URL.createObjectURL(blob);
    });
    p.catch(() => urls.delete(src));
    urls.set(src, p);
  }
  return p;
}

/** How much this browser stores, and asks it not to evict the library when space runs low. */
export async function storageInfo(): Promise<{ used: number; quota: number; persisted: boolean }> {
  const est = await navigator.storage?.estimate?.().catch(() => undefined);
  let persisted = (await navigator.storage?.persisted?.().catch(() => false)) ?? false;
  if (!persisted) persisted = (await navigator.storage?.persist?.().catch(() => false)) ?? false;
  return { used: est?.usage ?? 0, quota: est?.quota ?? 0, persisted };
}
