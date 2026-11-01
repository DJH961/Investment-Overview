import { CheckCircle2, Circle } from "lucide-react";
import { Link } from "react-router";
import { Card } from "../../components/Card";
import { PageHeader } from "../../components/PageHeader";
import { useAuthMe } from "../../lib/queries";
import { useAllocations, useSettings } from "../../lib/queries/manage";
import { usePrefs } from "../../lib/prefs";
import { PasskeysCard } from "../Settings/Settings";
import "./Onboarding.scss";

interface Step {
  id: string;
  title: string;
  body: string;
  done: boolean;
  action?: { to: string; label: string };
}

export function Onboarding() {
  const me = useAuthMe();
  const settings = useSettings();
  const { currency } = usePrefs();
  const alloc = useAllocations(currency);

  const steps: Step[] = [
    { id: "password", title: "Set your password", body: "You are signed in, so this is done.", done: true },
    {
      id: "passkey",
      title: "Add a passkey",
      body: "Sign in with Face ID, Touch ID or a security key instead of typing the password.",
      done: (me.data?.passkeys ?? 0) > 0,
    },
    {
      id: "import",
      title: "Import your first file",
      body: "Upload a broker export. Accounts and transactions are created from it.",
      done: Boolean(settings.data?.onboarded),
      action: { to: "/import", label: "Go to Import" },
    },
    {
      id: "targets",
      title: "Set target allocations",
      body: "Say how you would like your money split to see drift and rebalance plans.",
      done: (alloc.data?.targets.length ?? 0) > 0,
      action: { to: "/allocations", label: "Go to Allocations" },
    },
  ];
  const current = steps.findIndex((s) => !s.done);

  return (
    <div className="onboarding">
      <PageHeader title="Welcome" subtitle="Four short steps to get set up. You can skip any of them." />
      <ol className="onboarding__steps">
        {steps.map((s, i) => (
          <li
            key={s.id}
            className={
              s.done
                ? "onboarding__step onboarding__step--done"
                : i === current
                  ? "onboarding__step onboarding__step--current"
                  : "onboarding__step"
            }
            aria-current={i === current ? "step" : undefined}
          >
            <span className="onboarding__marker">
              {s.done ? <CheckCircle2 aria-label="Done" size={20} /> : <Circle aria-label="To do" size={20} />}
            </span>
            <div className="onboarding__text">
              <h2 className="onboarding__title">{s.title}</h2>
              <p className="onboarding__body">{s.body}</p>
              {s.action && !s.done && (
                <Link className="onboarding__link" to={s.action.to}>
                  {s.action.label}
                </Link>
              )}
            </div>
          </li>
        ))}
      </ol>
      {current === 1 && <PasskeysCard />}
      <Card>
        <Link className="onboarding__link" to="/overview">
          {current === -1 ? "All set. Go to Overview" : "Skip for now and go to Overview"}
        </Link>
      </Card>
    </div>
  );
}
