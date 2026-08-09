import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { NewOrderClient } from "./NewOrderClient";

export default async function NewOrderPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  return (
    <AppShell email={user.email}>
      <NewOrderClient />
    </AppShell>
  );
}
