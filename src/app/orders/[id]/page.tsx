import { redirect, notFound } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { connectToDatabase } from "@/lib/db";
import { findOwnedOrder } from "@/lib/orders";
import { serializeOrderDetail } from "@/lib/serialize";
import { ApiError } from "@/lib/errors";
import { AppShell } from "@/components/AppShell";
import { OrderDetailClient } from "./OrderDetailClient";

/**
 * Server-rendered so the order is on screen in the first response rather than
 * after a client round trip. The client component takes over from there and
 * keeps the copy it re-fetches after each payment.
 */
export default async function OrderPage({ params }: PageProps<"/orders/[id]">) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const { id } = await params;

  await connectToDatabase();

  let order;
  try {
    order = await findOwnedOrder(user, id);
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") notFound();
    throw error;
  }

  return (
    <AppShell email={user.email}>
      <OrderDetailClient initialOrder={serializeOrderDetail(order)} />
    </AppShell>
  );
}
