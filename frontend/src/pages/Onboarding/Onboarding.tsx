import { CheckCircle2, Circle } from "lucide-react";
import { Link } from "react-router";
import { Card } from "../../components/Card";
import { PageHeader } from "../../components/PageHeader";
import { useOnboarding } from "../../lib/queries/manage";
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
  const state = useOnboarding().data;

  const steps: Step[] = [
    {
      id: "account",
      title: "Create an account",
      body: "An account is a broker or bank holding. Importing a file creates one for you.",
      done: Boolean(state?.account),
      action: { to: "/import", label: "Go to Import" },
    },
    {
      id: "import",
      title: "Import your first file",
      body: "Upload a broker export. Accounts and transactions are created from it.",
      done: Boolean(state?.first_import),
      action: { to: "/import", label: "Go to Import" },
    },
    {
      id: "password",
      title: "Set your password",
      body: "Set it once on the server with inv-dashboard-set-password (see the runbook).",
      done: Boolean(state?.password),
    },
    {
      id: "passkey",
      title: "Add a passkey",
      body: "Sign in with Face ID, Touch ID or a security key instead of typing the password.",
      done: Boolean(state?.passkey),
    },
    {
      id: "conversions",
      title: "Record your currency conversions",
      body: "Optional. Enter the EUR to USD conversions you made so deposits show what you really paid.",
      done: Boolean(state?.conversions),
      action: { to: "/conversions", label: "Go to Conversions" },
    },
    {
      id: "targets",
      title: "Set target allocations",
      body: "Say how you would like your money split to see drift and rebalance plans.",
      done: Boolean(state?.targets),
      action: { to: "/allocations", label: "Go to Allocations" },
    },
  ];
  const current = steps.findIndex((s) => !s.done);

  return (
    <div className="onboarding">
      <PageHeader title="Welcome" subtitle="A few short steps to get set up. You can skip any of them." />
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
      {steps[current]?.id === "passkey" && <PasskeysCard />}
      <Card>
        <Link className="onboarding__link" to="/overview">
          {current === -1 ? "All set. Go to Overview" : "Skip for now and go to Overview"}
        </Link>
      </Card>
    </div>
  );
}
