import { writePersisted } from "./usePersistentState";

/** Device-local flag behind the Overview's setup guide card. */
export const ONBOARDING_DISMISSED_KEY = "onboarding.dismissed";

/** Bring the setup guide card back (Settings and the account menu call this, then open the Overview). */
export function restartSetupGuide(): void {
  writePersisted(ONBOARDING_DISMISSED_KEY, false);
}
