// Preserve device-local sidebar layout without changing conversation or agent state.
export const SIDEBAR_PREFERENCE_KEY = "nodeforge.sidebar.collapsed";

// Restore the sidebar layout safely when device storage is unavailable or malformed.
export function readSidebarPreference(storage = () => globalThis.localStorage) {
  try {
    return storage()?.getItem(SIDEBAR_PREFERENCE_KEY) === "true";
  } catch (error) {
    console.warn("Unable to restore sidebar preference", error);
    return false;
  }
}

// Save only the sidebar layout so storage failures cannot interrupt navigation.
export function writeSidebarPreference(collapsed, storage = () => globalThis.localStorage) {
  try {
    storage()?.setItem(SIDEBAR_PREFERENCE_KEY, String(collapsed));
  } catch (error) {
    console.warn("Unable to save sidebar preference", error);
  }
}
