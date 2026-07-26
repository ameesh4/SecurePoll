import { useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { ApiError } from "../../api/client";
import { useAuth } from "../../auth/useAuth";
import { btn, field, input, label } from "../../ui/classes";

interface Notice {
  title: string;
  body: string;
}

function toNotice(error: unknown): Notice {
  if (error instanceof ApiError) {
    if (error.code === "RATE_LIMITED") {
      return { title: "Too many attempts", body: error.message };
    }
    if (error.status === 401) {
      return { title: "Sign-in failed", body: error.message };
    }
    return { title: "Could not sign in", body: error.message };
  }
  return { title: "Could not sign in", body: "Please try again." };
}

export default function LoginPage() {
  const { login, status } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === "authenticated") {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from ?? "/admin"} replace />;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setNotice(null);
    try {
      await login(email, password);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from ?? "/admin", { replace: true });
    } catch (caught) {
      setNotice(toNotice(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen grid grid-cols-1 md:grid-cols-2 bg-bg">
      <aside className="flex flex-col p-7 md:p-12 bg-accent text-bg">
        <span className="font-extrabold text-[13px] tracking-[0.12em] uppercase">
          Secure Poll
        </span>

        {/* The width limit lives on the h1 in `em`, so it scales with the display size. On the
            wrapper, `ch`/`em` would resolve against the inherited 15px body font and collapse the
            headline to about one word per line. */}
        <div className="mt-6 md:mt-auto flex flex-col gap-6">
          <h1 className="m-0 font-extrabold text-[28px] md:text-[clamp(30px,3.6vw,46px)] leading-[1.04] tracking-tight text-bg max-w-[11em]">
            The server that knows who may vote. Never what they voted.
          </h1>
          <hr className="w-[132px] h-px border-0 m-0 bg-bg/55" />
          <p className="hidden md:block m-0 max-w-[42ch] text-[0.83rem] leading-normal text-bg/80">
            Every action you take here is written to an append-only audit record against
            your admin id.
          </p>
        </div>

        <span className="hidden md:block mt-14 text-[10px] font-semibold tracking-[0.1em] uppercase text-bg/70">
          Gandaki College of Engineering and Science · v1.0
        </span>
      </aside>

      <div className="grid place-items-center px-6 py-10 md:py-12">
        <form
          className="w-full max-w-[380px] flex flex-col gap-4"
          onSubmit={handleSubmit}
          noValidate
        >
          <span className="text-[10px] font-bold tracking-[0.12em] uppercase text-ink/45">
            Administrator access
          </span>
          <h2 className="m-0 text-[30px] font-extrabold tracking-tight">Sign in</h2>
          <p className="m-0 mb-2 text-[0.86rem] text-ink/55">
            Accounts are provisioned by the election commission. There is no self-service
            sign-up.
          </p>

          <div className={field}>
            <label className={label} htmlFor="email">
              Work email
            </label>
            <input
              id="email"
              type="email"
              className={input}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              required
            />
          </div>

          <div className={field}>
            <label className={label} htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              className={input}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </div>

          <button type="submit" className={`${btn} w-full mt-2`} disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>

          <div className="flex items-center justify-between gap-4 text-[0.8rem] text-ink/45">
            <Link
              to="/register"
              className="text-accent underline underline-offset-[3px]"
            >
              Registering to vote?
            </Link>
            <span>Sessions expire automatically</span>
          </div>

          {notice && (
            <div
              className="flex flex-col gap-0.5 px-4 py-3 mt-2 bg-neutral-100 border-l-[3px] border-accent"
              role="alert"
            >
              <span className="text-[10px] font-bold tracking-[0.1em] uppercase text-accent-800">
                {notice.title}
              </span>
              <p className="m-0 text-[0.84rem] text-ink">{notice.body}</p>
            </div>
          )}
        </form>
      </div>
    </main>
  );
}
