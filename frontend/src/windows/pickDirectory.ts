import { isDesktop, selectDirectory } from "../desktop";

/**
 * Ask for a folder: the native dialog in the app, a prompt in a plain browser
 * tab (where a page can't learn a folder's real path).
 */
export async function pickDirectory(): Promise<string | null> {
  if (isDesktop) {
    try {
      return await selectDirectory();
    } catch (err) {
      console.error("Failed to open directory dialog:", err);
      return null;
    }
  }
  const path = window.prompt("Folder path");
  return path?.trim() || null;
}
