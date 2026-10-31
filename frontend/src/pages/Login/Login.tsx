import { Lock } from "lucide-react";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import "./Login.scss";

/** Placeholder: the password form and passkey button arrive in a later step. */
export function Login() {
  return (
    <div className="login-page">
      <Card className="login-page__card">
        <EmptyState
          icon={<Lock aria-hidden />}
          title="Sign in"
          description="The password and passkey sign-in form is coming in a later step."
        />
      </Card>
    </div>
  );
}
