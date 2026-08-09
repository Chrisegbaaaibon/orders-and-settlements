import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";

/** The app has no marketing page — land people where they can act. */
export default async function Home() {
  const user = await getSessionUser();
  redirect(user ? "/dashboard" : "/login");
}
