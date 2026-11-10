import { X } from "lucide-react";
import { Link } from "react-router";
import { IconButton } from "../../components/IconButton";
import { useOnboarding } from "../../lib/queries/manage";
import { ONBOARDING_DISMISSED_KEY } from "../../lib/setupGuide";
import { usePersistentState } from "../../lib/usePersistentState";
import "./OnboardingCard.scss";

/**
 * A small, dismissible setup reminder shown while first-run steps are open. It never
 * takes over the page. Dismissal is remembered on this device ("Restart setup guide"
 * in Settings brings it back).
 */
export function OnboardingCard() {
  const [dismissed, setDismissed] = usePersistentState<boolean>(ONBOARDING_DISMISSED_KEY, false);
  const { data } = useOnboarding();
  if (dismissed || !data || data.complete) return null;
  const steps = [data.account, data.first_import, data.password, data.passkey, data.conversions, data.targets];
  const done = steps.filter(Boolean).length;
  return (
    <aside className="onboarding-card" aria-label="Setup guide">
      <p className="onboarding-card__text">
        <strong className="onboarding-card__title">Setup guide</strong>
        <span className="onboarding-card__progress">
          {done} of {steps.length} steps done
        </span>
      </p>
      <Link className="onboarding-card__link" to="/onboarding">
        Continue setup
      </Link>
      <IconButton label="Hide setup guide" size="sm" icon={<X aria-hidden />} onClick={() => setDismissed(true)} />
    </aside>
  );
}
