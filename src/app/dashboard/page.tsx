import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { DashboardClient } from "./DashboardClient";

export default async function DashboardPage() {
  const user = await getSessionUser();
  // The proxy already redirects signed-out visitors; this is the real check,
  // since the proxy only looks at cookie presence.
  if (!user) redirect("/login");

  return (
    <AppShell email={user.email}>
      <DashboardClient />
    </AppShell>
  );
}
