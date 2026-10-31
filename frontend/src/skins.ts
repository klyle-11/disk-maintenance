/**
 * Skins: the frame every window is made of. Each one can have a dark display
 * or white paper inside (its panel), and remembers which.
 */
export type Skin = "steel" | "silver" | "palesun" | "sunburnt" | "frost" | "gunmetal" | "obsidian";
export type Panel = "dark" | "light";

export interface SkinInfo {
  id: Skin;
  label: string;
  /** The inside a skin starts with until it's switched. */
  panel: Panel;
  /** For the picker: frame, dark panel, white panel, accent. */
  swatch: { frame: string; dark: string; light: string; accent: string };
}

export const SKINS: SkinInfo[] = [
  { id: "steel", label: "Cold Steel", panel: "dark", swatch: { frame: "#a7b0ba", dark: "#04070a", light: "#ffffff", accent: "#36c6ff" } },
  { id: "silver", label: "Silver", panel: "light", swatch: { frame: "#cdd3da", dark: "#06080a", light: "#ffffff", accent: "#1f6fd1" } },
  { id: "palesun", label: "Pale Sun", panel: "light", swatch: { frame: "#f8eeb4", dark: "#0d0b04", light: "#fffef8", accent: "#d9a21f" } },
  {
    id: "sunburnt",
    label: "Sunburnt",
    panel: "dark",
    swatch: { frame: "linear-gradient(160deg, #ffd45a, #f7862a 50%, #c24d10)", dark: "#120602", light: "#fffaf3", accent: "#ffcf3f" },
  },
  { id: "frost", label: "Frost", panel: "light", swatch: { frame: "#e3e9ef", dark: "#050a10", light: "#eef4f9", accent: "#0a6fb8" } },
  { id: "gunmetal", label: "Gunmetal", panel: "dark", swatch: { frame: "#434950", dark: "#030405", light: "#fcfcfd", accent: "#8fb3ff" } },
  { id: "obsidian", label: "Obsidian", panel: "dark", swatch: { frame: "#23262a", dark: "#000000", light: "#fffdf8", accent: "#ffb000" } },
];

const SKIN_KEY = "skin";
const PANELS_KEY = "skin-panels";

/** Skins that were renamed, so a saved choice still finds its way. */
const RENAMED: Record<string, Skin> = { butter: "palesun" };

export function readSkin(): Skin {
  try {
    const saved = localStorage.getItem(SKIN_KEY) ?? "";
    const id = RENAMED[saved] ?? saved;
    if (SKINS.some((s) => s.id === id)) return id as Skin;
  } catch {
    // No storage: use the default.
  }
  return "steel";
}

export function saveSkin(skin: Skin): void {
  try {
    localStorage.setItem(SKIN_KEY, skin);
  } catch {
    // The skin just won't be remembered.
  }
}

/** Each skin's chosen inside, defaulting to the one it comes with. */
export function readPanels(): Record<Skin, Panel> {
  const panels = Object.fromEntries(SKINS.map((s) => [s.id, s.panel])) as Record<Skin, Panel>;
  try {
    const saved = JSON.parse(localStorage.getItem(PANELS_KEY) || "{}");
    for (const s of SKINS) {
      if (saved[s.id] === "dark" || saved[s.id] === "light") panels[s.id] = saved[s.id];
    }
  } catch {
    // No storage, or nothing saved: the defaults.
  }
  return panels;
}

export function savePanels(panels: Record<Skin, Panel>): void {
  try {
    localStorage.setItem(PANELS_KEY, JSON.stringify(panels));
  } catch {
    // The choice just won't be remembered.
  }
}
