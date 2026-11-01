import { useQueryClient } from "@tanstack/react-query";
import { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill } from "@simplewebauthn/browser";
import { Eye, EyeOff, Fingerprint, LineChart, Lock } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { Button } from "../../components/Button";
import { Field } from "../../components/Field";
import { IconButton } from "../../components/IconButton";
import { Input } from "../../components/Input";
import { ApiError } from "../../lib/api";
import { invalidateAuth, login, passkeyLogin, safeNext } from "../../lib/auth";
import "./Login.scss";

function describeError(err: unknown, mode: "password" | "passkey"): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return "Too many attempts. Please try again in a minute.";
    if (err.status === 401) return mode === "password" ? "Wrong password. Please try again." : "Passkey was not accepted.";
    return `The server returned an error (${err.status}). Please try again.`;
  }
  if (err instanceof Error && (err.name === "NotAllowedError" || err.name === "AbortError")) {
    return "Passkey sign-in was cancelled.";
  }
  if (err instanceof TypeError || (typeof navigator !== "undefined" && navigator.onLine === false)) {
    return "You appear to be offline. Check your connection and try again.";
  }
  return "Sign-in failed. Please try again.";
}

export function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<"password" | "passkey" | null>(null);
  const [error, setError] = useState<{ text: string; field: boolean } | null>(null);
  const passkeys = browserSupportsWebAuthn();

  const done = useCallback(async () => {
    await invalidateAuth(queryClient);
    navigate(safeNext(location.search), { replace: true });
  }, [queryClient, navigate, location.search]);

  // Conditional UI: passkeys offered in the browser's autofill list.
  useEffect(() => {
    if (!passkeys) return;
    let cancelled = false;
    void (async () => {
      try {
        if (!(await browserSupportsWebAuthnAutofill())) return;
        await passkeyLogin(true);
        if (!cancelled) await done();
      } catch {
        /* dismissed or superseded by a manual attempt: stay silent */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [passkeys, done]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy("password");
    setError(null);
    try {
      await login(password);
      await done();
    } catch (err) {
      setError({ text: describeError(err, "password"), field: err instanceof ApiError && err.status === 401 });
      setBusy(null);
    }
  }

  async function onPasskey() {
    if (busy) return;
    setBusy("passkey");
    setError(null);
    try {
      await passkeyLogin(false);
      await done();
    } catch (err) {
      setError({ text: describeError(err, "passkey"), field: false });
      setBusy(null);
    }
  }

  return (
    <div className="login-page">
      <main className="login-page__card">
        <div className="login-page__brand">
          <span className="login-page__mark" aria-hidden>
            <LineChart />
          </span>
          <h1 className="login-page__title">Investment Overview</h1>
          <p className="login-page__subtitle">Sign in to see your portfolio.</p>
        </div>

        <form className="login-page__form" onSubmit={onSubmit} noValidate>
          <Field label="Password" error={error?.field ? error.text : undefined}>
            {(control) => (
              <div className="login-page__password">
                <Input
                  {...control}
                  className="login-page__input"
                  type={show ? "text" : "password"}
                  name="password"
                  autoComplete="current-password webauthn"
                  leftIcon={<Lock aria-hidden />}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <IconButton
                  className="login-page__toggle"
                  label={show ? "Hide password" : "Show password"}
                  icon={show ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                  onClick={() => setShow((s) => !s)}
                />
              </div>
            )}
          </Field>

          {error && !error.field && (
            <p className="login-page__error" role="alert">
              {error.text}
            </p>
          )}

          <Button type="submit" variant="primary" size="lg" fullWidth loading={busy === "password"} disabled={!password}>
            Sign in
          </Button>

          {passkeys && (
            <>
              <div className="login-page__divider" aria-hidden>
                <span>or</span>
              </div>
              <Button
                variant="secondary"
                size="lg"
                fullWidth
                leftIcon={<Fingerprint aria-hidden />}
                loading={busy === "passkey"}
                onClick={onPasskey}
              >
                Sign in with passkey
              </Button>
            </>
          )}
        </form>
      </main>
    </div>
  );
}
