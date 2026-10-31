export type Skin = "steel" | "gunmetal" | "frost";

export const SKINS: { id: Skin; label: string }[] = [
  { id: "steel", label: "Cold Steel" },
  { id: "gunmetal", label: "Gunmetal" },
  { id: "frost", label: "Frost" },
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
