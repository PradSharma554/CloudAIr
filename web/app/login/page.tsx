import { signIn } from "@/auth";

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm">
        <div className="mb-2 text-2xl font-semibold tracking-tight">CloudAIr</div>
        <p className="mb-8 text-sm text-zinc-500">
          The access layer between your website and AI agents — llms.txt, MCP,
          analytics, and rate limiting.
        </p>
        <div className="space-y-3">
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/sites" });
            }}
          >
            <button className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-2.5 text-sm font-medium hover:bg-zinc-50">
              Continue with Google
            </button>
          </form>
          <form
            action={async () => {
              "use server";
              await signIn("github", { redirectTo: "/sites" });
            }}
          >
            <button className="w-full rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-zinc-800">
              Continue with GitHub
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
