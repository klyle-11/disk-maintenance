export type Skin = "steel" | "silver" | "butter" | "frost" | "gunmetal" | "obsidian";

export interface SkinInfo {
  id: Skin;
  label: string;
  /** For the picker: frame metal, panel, and accent colours. */
  swatch: [string, string, string];
}

export const SKINS: SkinInfo[] = [
  { id: "steel", label: "Cold Steel", swatch: ["#a7b0ba", "#04070a", "#36c6ff"] },
  { id: "silver", label: "Silver & White", swatch: ["#c3cad2", "#ffffff", "#1f6fd1"] },
  { id: "butter", label: "Warm Yellow", swatch: ["#f2c94c", "#fffdf5", "#c96f00"] },
  { id: "frost", label: "Frost", swatch: ["#e3e9ef", "#d6e3ec", "#0a6fb8"] },
  { id: "gunmetal", label: "Gunmetal", swatch: ["#4a5159", "#030405", "#8fb3ff"] },
  { id: "obsidian", label: "Obsidian", swatch: ["#24262a", "#000000", "#ffb000"] },
];

const SKIN_KEY = "skin";

export function readSkin(): Skin {
  try {
    const saved = localStorage.getItem(SKIN_KEY);
    if (SKINS.some((s) => s.id === saved)) return saved as Skin;
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
