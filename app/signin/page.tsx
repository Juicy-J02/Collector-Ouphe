"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";

interface SessionUser {
  id: number;
  username: string;
  email: string;
}

const inputClass =
  "w-full rounded-xl border border-border bg-background px-4 py-3 text-foreground placeholder:text-muted focus:border-teal";

const labelClass =
  "text-sm font-medium text-foreground";

const primaryButtonClass =
  "btn-primary w-full px-4 py-3 text-center disabled:opacity-50";

const secondaryButtonClass =
  "btn-secondary inline-flex w-full items-center justify-center rounded-xl border px-4 py-3 font-semibold transition-colors disabled:opacity-50";

export default function SignIn() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [sessionError, setSessionError] = useState("");

  const [registering, setRegistering] = useState(false);
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    async function checkSession() {
      try {
        const response = await fetch("/api/auth/session", {
          cache: "no-store",
          signal: controller.signal,
        });

        if (controller.signal.aborted) return;

        if (response.status === 401) {
          setUser(null);
          return;
        }

        const data = await response.json();

        if (!response.ok) {
          throw new Error(
            data.error ?? "Could not check session."
          );
        }

        if (!controller.signal.aborted) {
          setUser(data.user);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setSessionError(
            error instanceof Error
              ? error.message
              : "Could not check session."
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          setCheckingSession(false);
        }
      }
    }

    void checkSession();

    return () => controller.abort();
  }, []);

  function toggleMode() {
    setRegistering((current) => !current);
    setError("");
    setSuccess("");
    setPassword("");
    setShowPassword(false);
  }

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    if (submitting) return;

    setError("");
    setSuccess("");
    setSubmitting(true);

    try {
      const endpoint = registering
        ? "/api/auth/register"
        : "/api/auth/signin";

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          registering
            ? {
              email: email.trim(),
              username: username.trim(),
              password,
            }
            : {
              email: email.trim(),
              password,
            }
        ),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error ?? "Request failed.");
      }

      setPassword("");
      setShowPassword(false);

      if (registering) {
        setRegistering(false);
        setSuccess("Account created. You can now sign in.");
      } else {
        window.location.href = "/";
      }
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not submit form."
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function signOut() {
    if (submitting) return;

    setError("");
    setSuccess("");
    setSubmitting(true);

    try {
      const response = await fetch("/api/auth/session", {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error("Could not sign out.");
      }

      window.location.href = "/signin";
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not sign out."
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center px-5 py-10 text-foreground sm:px-6 sm:py-16">
      <div className="w-full max-w-md">
        <div className="mb-7 text-center">
          <Link
            href="/"
            className="inline-flex items-center gap-3"
          >
            <span
              aria-hidden="true"
              className="brand-mark flex h-12 w-12 items-center justify-center rounded-2xl text-2xl font-bold"
            >
              CO
            </span>

            <span className="text-2xl font-bold tracking-tight text-accent">
              Collector Ouphe
            </span>
          </Link>
        </div>

        <section
          aria-label="Your account"
          className="overflow-hidden rounded-2xl border border-accent/25 bg-surface shadow-2xl shadow-black/30"
        >
          <div
            aria-hidden="true"
            className="h-1 bg-linear-to-r from-teal via-accent to-teal"
          />

          <div className="p-6 sm:p-8">
            {checkingSession ? (
              <div
                role="status"
                className="py-8 text-center"
              >
                <span className="badge">
                  Your account
                </span>

                <p className="mt-4 text-muted">
                  Checking session…
                </p>
              </div>
            ) : sessionError ? (
              <div className="space-y-5">
                <h1 className="text-2xl font-semibold">
                  Unable to load your account
                </h1>

                <p
                  role="alert"
                  className="rounded-xl border border-red-400/25 bg-red-400/10 p-4 text-sm text-red-300"
                >
                  {sessionError}
                </p>

                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className={primaryButtonClass}
                >
                  Try Again
                </button>
              </div>
            ) : (
              <>
                <header>
                  <span className="badge">
                    {user
                      ? "Account"
                      : registering
                        ? "Join Collector Ouphe"
                        : "Welcome back"}
                  </span>

                  <h1 className="mt-4 break-words text-3xl font-semibold">
                    {user
                      ? `Welcome, ${user.username}`
                      : registering
                        ? "Create your account"
                        : "Sign in"}
                  </h1>

                  <p className="mt-3 text-sm leading-6 text-muted">
                    {user
                      ? "You’re signed in and ready to manage your collection."
                      : registering
                        ? "Start organizing your cards and tracking your collection’s value."
                        : "Pick up where you left off with your cards, transactions, and collection value."}
                  </p>
                </header>

                {error && (
                  <p
                    role="alert"
                    className="mt-5 rounded-xl border border-red-400/25 bg-red-400/10 p-4 text-sm text-red-300"
                  >
                    {error}
                  </p>
                )}

                {success && (
                  <p
                    role="status"
                    className="mt-5 rounded-xl border border-green-400/25 bg-green-400/10 p-4 text-sm text-green-300"
                  >
                    {success}
                  </p>
                )}

                {user ? (
                  <div className="mt-7 space-y-5">
                    <div className="rounded-xl border border-border bg-background p-4">
                      <p className="text-xs font-medium uppercase tracking-wider text-muted">
                        Signed in as
                      </p>

                      <p className="mt-2 break-words font-medium">
                        {user.username}
                      </p>

                      <p className="mt-1 break-words text-sm text-muted">
                        {user.email}
                      </p>
                    </div>

                    <div className="flex flex-col gap-3">
                      <Link
                        href="/"
                        className={primaryButtonClass}
                      >
                        Your Dashboard →
                      </Link>

                      <button
                        type="button"
                        onClick={() => void signOut()}
                        disabled={submitting}
                        className={secondaryButtonClass}
                      >
                        {submitting
                          ? "Signing out…"
                          : "Sign Out"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <form
                      onSubmit={handleSubmit}
                      className="mt-7"
                    >
                      <fieldset
                        disabled={submitting}
                        className="flex flex-col gap-5"
                      >
                        <div className="flex flex-col gap-2">
                          <label
                            htmlFor="email"
                            className={labelClass}
                          >
                            Email
                          </label>

                          <input
                            id="email"
                            name="email"
                            type="email"
                            autoComplete={
                              registering
                                ? "email"
                                : "username"
                            }
                            placeholder="you@example.com"
                            required
                            value={email}
                            onChange={(event) =>
                              setEmail(event.target.value)
                            }
                            className={inputClass}
                          />
                        </div>

                        {registering && (
                          <div className="flex flex-col gap-2">
                            <label
                              htmlFor="username"
                              className={labelClass}
                            >
                              Username
                            </label>

                            <input
                              id="username"
                              name="username"
                              type="text"
                              autoComplete="username"
                              placeholder="Choose a username"
                              required
                              maxLength={50}
                              value={username}
                              onChange={(event) =>
                                setUsername(
                                  event.target.value
                                )
                              }
                              className={inputClass}
                            />
                          </div>
                        )}

                        <div className="flex flex-col gap-2">
                          <div className="flex items-center justify-between gap-3">
                            <label
                              htmlFor="password"
                              className={labelClass}
                            >
                              Password
                            </label>

                            <button
                              type="button"
                              aria-controls="password"
                              aria-pressed={showPassword}
                              aria-label={
                                showPassword
                                  ? "Hide password"
                                  : "Show password"
                              }
                              onClick={() =>
                                setShowPassword(
                                  (current) => !current
                                )
                              }
                              className="rounded border-0 bg-transparent px-1 py-1 text-xs font-medium text-teal hover:bg-transparent hover:text-foreground disabled:opacity-50"
                            >
                              {showPassword
                                ? "Hide"
                                : "Show"}
                            </button>
                          </div>

                          <input
                            id="password"
                            name="password"
                            type={
                              showPassword
                                ? "text"
                                : "password"
                            }
                            autoComplete={
                              registering
                                ? "new-password"
                                : "current-password"
                            }
                            placeholder={
                              registering
                                ? "Choose a password"
                                : "Enter your password"
                            }
                            required
                            minLength={
                              registering ? 8 : undefined
                            }
                            aria-describedby={
                              registering
                                ? "password-hint"
                                : undefined
                            }
                            value={password}
                            onChange={(event) =>
                              setPassword(
                                event.target.value
                              )
                            }
                            className={inputClass}
                          />

                          {registering && (
                            <p
                              id="password-hint"
                              className="text-xs text-muted"
                            >
                              Use at least 8 characters.
                            </p>
                          )}
                        </div>

                        <button
                          type="submit"
                          className={`${primaryButtonClass} mt-1`}
                        >
                          {submitting
                            ? "Please wait…"
                            : registering
                              ? "Create Account"
                              : "Sign In →"}
                        </button>
                      </fieldset>
                    </form>

                    <div className="mt-7 border-t border-border pt-5 text-center">
                      <p className="text-sm text-muted">
                        {registering
                          ? "Already have an account?"
                          : "New to Collector Ouphe?"}
                      </p>

                      <button
                        type="button"
                        onClick={toggleMode}
                        disabled={submitting}
                        className={`${secondaryButtonClass} mt-3`}
                      >
                        {registering
                          ? "Sign In Instead"
                          : "Create an Account"}
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </section>

        {!checkingSession && !user && (
          <div className="mt-6 text-center">
            <Link
              href="/"
              className="text-sm text-muted transition-colors hover:text-accent"
            >
              Back to home →
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}