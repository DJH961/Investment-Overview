import { useQueryClient } from "@tanstack/react-query";
import { WebAuthnAbortService, browserSupportsWebAuthn, browserSupportsWebAuthnAutofill } from "@simplewebauthn/browser";
import { Eye, EyeOff, Fingerprint, Lock } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { BrandMark } from "../../components/BrandMark";
import { Button } from "../../components/Button";
import { Field } from "../../components/Field";
import { IconButton } from "../../components/IconButton";
import { Input } from "../../components/Input";
import { ApiError, isNetworkError } from "../../lib/api";
import {
  clearSignedOutFlag,
  invalidateAuth,
  login,
  notePasskeyAutoDeclined,
  passkeyLogin,
  safeNext,
  shouldAutoPromptPasskey,
} from "../../lib/auth";
import "./Login.scss";

function isPasskeyCancel(err: unknown): boolean {
  return err instanceof Error && (err.name === "NotAllowedError" || err.name === "AbortError");
}

/** Resolves once the page is visible and focused (browsers refuse WebAuthn otherwise). */
function whenFocused(): Promise<void> {
  if (typeof document === "undefined" || (document.visibilityState === "visible" && document.hasFocus())) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      window.removeEventListener("focus", done);
      document.removeEventListener("visibilitychange", done);
      resolve();
    };
    window.addEventListener("focus", done);
    document.addEventListener("visibilitychange", done);
  });
}

/** A rejection this fast was not a person pressing Cancel (no credential, or the browser wanted a tap). */
const INSTANT_REJECT_MS = 800;

function describeError(err: unknown, mode: "password" | "passkey"): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return "Too many attempts. Please try again in a minute.";
    if (err.status === 401) return mode === "password" ? "Wrong password. Please try again." : "Passkey was not accepted.";
    return `The server returned an error (${err.status}). Please try again.`;
  }
  if (isPasskeyCancel(err)) return "Passkey sign-in was cancelled.";
  if (isNetworkError(err) || err instanceof TypeError || (typeof navigator !== "undefined" && navigator.onLine === false)) {
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
  const reauth = new URLSearchParams(location.search).get("reauth") === "1";

  const done = useCallback(async () => {
    clearSignedOutFlag();
    await invalidateAuth(queryClient);
    navigate(safeNext(location.search), { replace: true });
  }, [queryClient, navigate, location.search]);
  // The effect below runs once per visit; it reads the latest `done` from here.
  const doneRef = useRef(done);
  useEffect(() => {
    doneRef.current = done;
  }, [done]);
  const passwordRef = useRef<HTMLInputElement>(null);

  // On a device that signed in with a passkey before, open the passkey dialog
  // straight away (one tap or a glance instead of typing). If it is dismissed or
  // not possible, fall back to the password form with passkeys offered in the
  // browser's autofill list (conditional UI).
  useEffect(() => {
    if (!passkeys) return;
    let cancelled = false;
    void (async () => {
      // Let StrictMode's dev double-mount settle so only one ceremony (and one
      // server challenge cookie) is in flight.
      await new Promise((r) => setTimeout(r, 0));
      if (cancelled) return;
      if (shouldAutoPromptPasskey()) {
        await whenFocused();
        if (cancelled) return;
        setBusy("passkey");
        const started = Date.now();
        try {
          await passkeyLogin(false);
          if (!cancelled) await doneRef.current();
          return;
        } catch (err) {
          if (cancelled) return;
          setBusy((b) => (b === "passkey" ? null : b));
          if (isPasskeyCancel(err)) {
            if (Date.now() - started > INSTANT_REJECT_MS) notePasskeyAutoDeclined();
          } else if (err instanceof ApiError || isNetworkError(err)) {
            setError({ text: describeError(err, "passkey"), field: false });
          }
          passwordRef.current?.focus();
        }
      }
      try {
        if (cancelled || !(await browserSupportsWebAuthnAutofill())) return;
        await passkeyLogin(true);
        if (!cancelled) await doneRef.current();
      } catch {
        /* dismissed or superseded by a manual attempt: stay silent */
      }
    })();
    return () => {
      cancelled = true;
      // Leaving the page (e.g. signed in by password): close any open dialog.
      WebAuthnAbortService.cancelCeremony();
    };
  }, [passkeys]);

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
            <BrandMark tile={false} />
          </span>
          <h1 className="login-page__title">Investment Overview</h1>
          <p className="login-page__subtitle">Sign in to see your portfolio.</p>
        </div>

        {reauth && (
          <output className="login-page__notice">
            For your security, please sign in again to continue.
          </output>
        )}

        <form className="login-page__form" onSubmit={onSubmit} noValidate>
          <Field label="Password" error={error?.field ? error.text : undefined}>
            {(control) => (
              <div className="login-page__password">
                <Input
                  {...control}
                  ref={passwordRef}
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
