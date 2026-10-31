/**
 * Shaping a comparison tree for the paired source/target windows: which rows
 * show, and the path lists each side can copy.
 */
import type { ComparisonItem, ComparisonStatus } from "../api";

export type StatusFilter = "all" | ComparisonStatus;
export type Side = "source" | "target";

export interface Row {
  /** Relative path, the row's identity on both sides. */
  key: string;
  item: ComparisonItem;
  depth: number;
}

export function existsOn(side: Side, item: ComparisonItem): boolean {
  return side === "source" ? item.status !== "extra_in_target" : item.status !== "missing_from_target";
}

function fileMatches(item: ComparisonItem, filter: StatusFilter, diffOnly: boolean): boolean {
  if (filter !== "all") return item.status === filter;
  return !diffOnly || item.status !== "identical";
}

/** Every item that shows under a filter: matches, or holds something that does. */
export function visibleItems(tree: ComparisonItem[], filter: StatusFilter, diffOnly: boolean): Set<ComparisonItem> {
  const shown = new Set<ComparisonItem>();
  const visit = (item: ComparisonItem): boolean => {
    let show: boolean;
    if (item.itemType === "file") {
      show = fileMatches(item, filter, diffOnly);
    } else {
      let anyChild = false;
      for (const child of item.children ?? []) if (visit(child)) anyChild = true;
      const empty = !item.children?.length;
      show = anyChild || item.status === filter || (empty && fileMatches(item, filter, diffOnly));
    }
    if (show) shown.add(item);
    return show;
  };
  tree.forEach(visit);
  return shown;
}

/** The rows on screen, top to bottom; the same list draws both sides. */
export function flattenRows(tree: ComparisonItem[], expanded: Set<string>, shown: Set<ComparisonItem>): Row[] {
  const rows: Row[] = [];
  const walk = (items: ComparisonItem[], parent: string, depth: number) => {
    for (const item of items) {
      if (!shown.has(item)) continue;
      const key = parent ? `${parent}/${item.name}` : item.name;
      rows.push({ key, item, depth });
      if (item.itemType === "folder" && item.children && expanded.has(key)) walk(item.children, key, depth + 1);
    }
  };
  walk(tree, "", 0);
  return rows;
}

/** Keys of every folder that shows, for "expand all". */
export function folderKeys(tree: ComparisonItem[], shown?: Set<ComparisonItem>): Set<string> {
  const keys = new Set<string>();
  const walk = (items: ComparisonItem[], parent: string) => {
    for (const item of items) {
      if (shown && !shown.has(item)) continue;
      const key = parent ? `${parent}/${item.name}` : item.name;
      if (item.itemType === "folder") {
        keys.add(key);
        if (item.children) walk(item.children, key);
      }
    }
  };
  walk(tree, "");
  return keys;
}

/** Keys of the top-level folders: how a fresh comparison opens. */
export function topLevelFolders(tree: ComparisonItem[]): Set<string> {
  return new Set(tree.filter((i) => i.itemType === "folder").map((i) => i.name));
}

/** The files a side's path list covers under the current filter. */
export function sidePicker(side: Side, filter: StatusFilter) {
  return (item: ComparisonItem) =>
    item.itemType === "file" &&
    existsOn(side, item) &&
    (filter === "all" ? item.status !== "identical" : item.status === filter);
}

export function pickedFiles(tree: ComparisonItem[], pick: (item: ComparisonItem) => boolean): string[] {
  const paths: string[] = [];
  const walk = (items: ComparisonItem[], parent: string) => {
    for (const item of items) {
      const key = parent ? `${parent}/${item.name}` : item.name;
      if (pick(item)) paths.push(key);
      if (item.children) walk(item.children, key);
    }
  };
  walk(tree, "");
  return paths;
}

/**
 * The picked files as few paths as possible: a folder whose every file is
 * picked becomes `folder/**`, and sibling files become `dir/{a,b,c}`.
 */
export function consolidatedPaths(tree: ComparisonItem[], pick: (item: ComparisonItem) => boolean): string[] {
  const complete = (item: ComparisonItem): boolean =>
    item.itemType === "file" ? pick(item) : !!item.children?.length && item.children.every(complete);

  const raw: string[] = [];
  const walk = (items: ComparisonItem[], parent: string) => {
    for (const item of items) {
      const key = parent ? `${parent}/${item.name}` : item.name;
      if (item.itemType === "file") {
        if (pick(item)) raw.push(key);
      } else if (complete(item)) {
        raw.push(`${key}/**`);
      } else if (item.children) {
        walk(item.children, key);
      }
    }
  };
  walk(tree, "");

  const folders = raw.filter((p) => p.endsWith("/**")).map((p) => p.slice(0, -3));
  const byDir = new Map<string, string[]>();
  for (const p of raw) {
    if (p.endsWith("/**")) continue;
    const slash = p.lastIndexOf("/");
    const dir = slash >= 0 ? p.slice(0, slash) : "";
    if (folders.some((f) => dir === f || dir.startsWith(`${f}/`))) continue;
    byDir.set(dir, [...(byDir.get(dir) ?? []), slash >= 0 ? p.slice(slash + 1) : p]);
  }

  const result = folders
    .filter((f) => !folders.some((other) => other !== f && f.startsWith(`${other}/`)))
    .map((f) => `${f}/**`);
  for (const [dir, files] of byDir) {
    files.sort();
    const name = files.length === 1 ? files[0] : `{${files.join(",")}}`;
    result.push(dir ? `${dir}/${name}` : name);
  }
  return result.sort();
}

export function fullPath(base: string, relative: string): string {
  const normalized = base.replace(/\\/g, "/");
  return (normalized.endsWith("/") ? normalized : `${normalized}/`) + relative;
}
