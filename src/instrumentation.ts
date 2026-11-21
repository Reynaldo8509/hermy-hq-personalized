export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { expirePendingApprovals } = await import("@/lib/queue-request");
  const sweep = async () => {
    try {
      const expired = await expirePendingApprovals();
      if (expired > 0) console.info("Approval expiry sweep completed", { expired });
    } catch (error) {
      console.error("Approval expiry sweep failed", {
        errorClass: error instanceof Error ? error.name : "unknown",
      });
    }
  };

  void sweep();
  const timer = setInterval(() => void sweep(), 60_000);
  timer.unref?.();
}
