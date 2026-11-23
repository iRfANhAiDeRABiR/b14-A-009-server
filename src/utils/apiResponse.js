/**
 * Sends standardized JSON success envelopes across GearNest controllers.
 */
export function sendSuccess(
  res,
  {
    statusCode = 200,
    message = "Operation completed successfully",
    data = null,
    pagination = null,
    summary = null,
  } = {}
) {
  const body = {
    success: true,
    message,
    data,
  };

  if (pagination) {
    body.pagination = pagination;
  }

  if (summary) {
    body.summary = summary;
  }

  return res.status(statusCode).json(body);
}
