export async function noStore(pending: Response | Promise<Response>): Promise<Response> {
  const response = await pending;
  response.headers.set("Cache-Control", "no-store");
  return response;
}
