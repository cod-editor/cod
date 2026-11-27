export type ReviewDeliveryStatus =
  "queued" | "dispatching" | "acknowledged" | "uncertain" | "cancelled";

export function isReviewFeedbackPending(
  status?: ReviewDeliveryStatus,
): boolean {
  return (
    status === "queued" || status === "dispatching" || status === "uncertain"
  );
}
