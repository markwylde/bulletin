import type { APIRoute } from "astro";
import { storage } from "../../storage.ts";
import { unfurlImageResponse } from "../../unfurl/image.ts";

/** `GET /unfurl/<hash>` (task 3.2). */
export const GET: APIRoute = ({ params }) => unfurlImageResponse(storage, params.hash ?? "");
