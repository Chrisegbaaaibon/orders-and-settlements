import mongoose from "mongoose";
import { Order, type OrderHydrated } from "@/models/Order";
import { ApiError } from "./errors";
import type { SessionUser } from "./auth";

/**
 * Load an order the user owns, or throw 404.
 *
 * A row belonging to someone else returns "not found" rather than "forbidden":
 * a 403 would confirm the id exists, which leaks the size and shape of other
 * tenants' data.
 */
export async function findOwnedOrder(
  user: SessionUser,
  orderId: string,
): Promise<OrderHydrated> {
  if (!mongoose.Types.ObjectId.isValid(orderId)) {
    throw new ApiError("not_found", "Order not found.");
  }

  const order = await Order.findOne({
    _id: new mongoose.Types.ObjectId(orderId),
    userId: new mongoose.Types.ObjectId(user.id),
  });

  if (!order) throw new ApiError("not_found", "Order not found.");
  return order;
}
